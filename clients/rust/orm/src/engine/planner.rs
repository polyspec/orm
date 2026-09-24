//! Turns a validated request into a plan: one statement per step, relations
//! as separate steps bound to the rows of their parent step.

use std::sync::Arc;

use super::dialect::{Dialect, CURRENT_TIME_TOKEN};
use super::err;
use crate::codes;
use crate::ir;
use crate::plan::{Assemble, BindSlot, Child, IfParent, KeyRef, OutCol, ParentRef, Plan, Step};
use crate::schema::{ColumnSchema, EntitySchema, Manifest, Relation};
use crate::Result;

pub(crate) struct Planner<'m> {
    pub m: &'m Manifest,
    pub d: Dialect,
}

/// One entity occurrence in a statement (the root or a join) with its alias.
struct Scope<'a> {
    ent: &'a EntitySchema,
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
}

impl Builder {
    fn new(d: Dialect) -> Builder {
        Builder { d, binds: Vec::new(), subs: 0 }
    }

    fn slot(&mut self, slot: BindSlot) -> String {
        self.binds.push(slot);
        self.d.placeholder(self.binds.len())
    }

    fn param(&mut self, i: usize) -> String {
        self.slot(BindSlot { from: "param".into(), param: i, ..Default::default() })
    }

    fn param_t(&mut self, i: usize, transform: &str) -> String {
        self.slot(BindSlot { from: "param".into(), param: i, transform: transform.into(), ..Default::default() })
    }

    fn config(&mut self, name: &str) -> String {
        self.slot(BindSlot { from: "config".into(), name: name.into(), ..Default::default() })
    }

    /// A timestamp the executor supplies.
    fn now(&mut self) -> String {
        self.slot(BindSlot { from: "now".into(), ..Default::default() })
    }

    fn parent_list(&mut self, step: usize) -> String {
        self.slot(BindSlot { from: "parent".into(), step: step as u32, ..Default::default() })
    }

    /// Replaces each `?` of a fragment with the placeholder of the next bind.
    fn fill(&mut self, frag: &str, ps: &[usize]) -> Result<String> {
        let n = frag.matches('?').count();
        if n != ps.len() {
            return Err(err(codes::IR_INVALID, format!("fragment has {n} placeholders but {} binds", ps.len())));
        }
        let mut out = String::with_capacity(frag.len());
        let mut k = 0;
        for ch in frag.chars() {
            if ch == '?' {
                let ph = self.param(ps[k]);
                out.push_str(&ph);
                k += 1;
            } else {
                out.push(ch);
            }
        }
        Ok(out)
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

fn is_aes(col: &ColumnSchema) -> bool {
    col.styles.iter().any(|s| s == "aes")
}

/// The version column written with AES values.
fn aes_version_column(ent: &EntitySchema) -> &'static str {
    if ent.columns.iter().any(is_aes) {
        "aes_key_version"
    } else {
        ""
    }
}

fn assigned(set: &[ir::Assign], col: &str) -> bool {
    set.iter().any(|a| a.column == col)
}

fn assigns_aes(ent: &EntitySchema, set: &[ir::Assign]) -> bool {
    set.iter().any(|a| ent.column(&a.column).map(is_aes).unwrap_or(false))
}

/// Keeps the row-level key-version invariant: the version is managed by the
/// planner, and an update of encrypted data replaces every AES column.
fn validate_aes_assignments(ent: &EntitySchema, set: &[ir::Assign], require_complete: bool) -> Result<()> {
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
    for col in &ent.columns {
        if is_aes(col) && !assigned(set, &col.name) {
            return Err(err(codes::IR_INVALID, format!("AES update must assign every AES column; missing {}", col.name)));
        }
    }
    Ok(())
}

/// An insert assigns every required column: a NOT NULL column without a
/// default that is neither automatic nor the AES key version the planner
/// writes. MySQL fills an omitted NOT NULL ENUM column with its first value.
fn validate_required_assignments(ent: &EntitySchema, set: &[ir::Assign]) -> Result<()> {
    let version = aes_version_column(ent);
    for col in &ent.columns {
        if col.nullable || col.default.is_some() || col.auto || col.name == version || assigned(set, &col.name) {
            continue;
        }
        return Err(err(codes::IR_INVALID, format!("required column {}.{} is not set", ent.name, col.name)));
    }
    Ok(())
}

fn add_blind_index_assignments(ent: &EntitySchema, mut set: Vec<ir::Assign>) -> Vec<ir::Assign> {
    for a in set.clone() {
        let Some(col) = ent.column(&a.column) else { continue };
        if !is_aes(col) || col.blind_index.is_empty() || assigned(&set, &col.blind_index) {
            continue;
        }
        set.push(ir::Assign { column: col.blind_index.clone(), p: a.p, null: a.null, ..Default::default() });
    }
    set
}

fn blind_index_source<'e>(ent: &'e EntitySchema, target: &str) -> Option<&'e ColumnSchema> {
    ent.columns.iter().find(|c| c.blind_index == target)
}

/// The unique key an upsert conflicts on: the first declared unique key whose
/// columns are all inserted, else the primary key.
fn conflict_target(ent: &EntitySchema, set: &[ir::Assign]) -> Vec<String> {
    for uk in &ent.unique {
        if uk.iter().all(|c| assigned(set, c)) {
            return uk.clone();
        }
    }
    ent.pk.clone()
}

/// The types executors normalize before binding.
fn bind_type(col: &ColumnSchema) -> String {
    match col.typ.as_str() {
        "date" | "time" | "datetime" | "point" => col.typ.clone(),
        _ => String::new(),
    }
}

fn function_type(name: &str, col: Option<&ColumnSchema>) -> String {
    match name {
        "day_of_week" | "year" | "month" => "i64".into(),
        "date" => "date".into(),
        "distance" | "point_x" | "point_y" => "f64".into(),
        _ => col.map(|c| c.typ.clone()).unwrap_or_else(|| "string".into()),
    }
}

fn relation_columns(rel: &Relation) -> (Vec<String>, Vec<String>) {
    rel.keys.iter().map(|k| (k.local.clone(), k.target.clone())).unzip()
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
    fn entity(&self, name: &str) -> Result<&'m EntitySchema> {
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
            other => return Err(err(codes::IR_INVALID, format!("unknown kind {other:?}"))),
        }
        for (i, st) in steps.iter_mut().enumerate() {
            st.id = i as u32;
        }
        Ok(Plan { schema_hash: self.m.schema_hash.clone(), kind: r.kind.clone(), steps })
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

    fn app_styles(&self, styles: &[String]) -> Vec<String> {
        styles.iter().filter(|s| !self.d.handles_style(s)).cloned().collect()
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
        let grouped = !q.group_by.is_empty() || !q.group_by_expr.is_empty();
        let group_count = kind == "count" && grouped;
        match kind {
            "count" => sb.push_str(if group_count { "1" } else { "COUNT(*)" }),
            "sum" => sb.push_str(&format!("COALESCE(SUM({}), 0)", self.qcol(root, agg))),
            "avg" => sb.push_str(&format!("AVG({})", self.qcol(root, agg))),
            "group_count" => {
                self.select_group_count_list(root, &mut sb, &mut asm, &mut out_names)?;
                let mut keys = q.group_by.clone();
                keys.extend(q.group_by_expr.iter().map(|g| g.as_.clone()));
                asm.key = asm.key_refs(&keys)?;
            }
            _ => {
                self.select_list(&mut b, root, &mut sb, &mut asm, &mut out_names)?;
                asm.key = asm.key_refs(&root.ent.pk)?;
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
            let mut order = self.render_order(&mut b, root, q)?;
            if order.is_empty() {
                order = format!(" ORDER BY {} ASC", self.qcol(root, &root.ent.pk[0]));
            }
            sb.push_str(&format!(
                ", ROW_NUMBER() OVER (PARTITION BY {}{order}) AS {}",
                self.qualified(root, &rc.child_keys).join(", "),
                self.d.quote("orm_rn")
            ));
        }
        sb.push_str(&format!(" FROM {} AS {}", self.d.quote(&root.ent.table), self.d.quote(&root.alias)));
        if !q.force_index.is_empty() {
            sb.push_str(&self.d.force_index(&q.force_index));
        }
        self.render_joins(&mut b, root, root, &mut sb)?;
        let mut where_ = Vec::new();
        if let Some(rc) = rc {
            let list = b.parent_list(rc.parent_step);
            if rc.child_keys.len() == 1 {
                where_.push(format!("{} IN ({list})", self.qcol(root, &rc.child_keys[0])));
            } else {
                where_.push(format!("({}) IN (({list}))", self.qualified(root, &rc.child_keys).join(", ")));
            }
        }
        if !root.ent.soft_delete.is_empty() {
            where_.push(format!("{} IS NULL", self.qcol(root, &root.ent.soft_delete)));
        }
        if let Some(g) = q.where_.as_ref().filter(|g| !g.items.is_empty()) {
            where_.push(self.render_group(&mut b, root, root, g, rc.is_none())?);
        }
        self.collect_join_where(&mut b, root, root, &mut where_)?;
        if !where_.is_empty() {
            sb.push_str(" WHERE ");
            sb.push_str(&where_.join(" AND "));
        }
        if grouped && matches!(kind, "one" | "all" | "group_count" | "count") && (kind != "count" || group_count) {
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
                sb.push_str(&self.render_order(&mut b, root, q)?);
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
        let mut st = Step { role: "main".into(), sql: sb, lock: q.lock.clone(), bind_slots: b.binds, ..Default::default() };
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
            let (parent_keys, child_keys, kind, target) = if !r.left.is_empty() {
                (vec![r.left.clone()], vec![r.right.clone()], r.kind.clone(), self.entity(&r.query.entity)?)
            } else {
                let rel = s.ent.relations.get(&r.rel).ok_or_else(|| err(codes::RELATION_UNKNOWN, format!("{}.{}", s.ent.name, r.rel)))?;
                let (l, t) = relation_columns(rel);
                (l, t, rel.kind.clone(), self.entity(&rel.target)?)
            };
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
                key_refs_of(&child_asm, &self.entity(&child_asm.entity)?.pk)?
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
                    cascade: !r.query.no_cascade_delete && parent_keys == s.ent.pk && child_keys != target.pk,
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

    fn render_order(&self, b: &mut Builder, s: &Scope<'_>, q: &ir::Query) -> Result<String> {
        if q.order.is_empty() {
            return Ok(String::new());
        }
        let mut parts = Vec::with_capacity(q.order.len());
        for o in &q.order {
            if o.random {
                parts.push(self.d.random().to_owned());
                continue;
            }
            if !o.expr.is_empty() {
                // a raw order expression carries its own direction
                parts.push(self.render_expr(s, &o.expr)?);
                continue;
            }
            let col = match &o.r#fn {
                Some(f) => self.column_function(b, s, &o.column, f)?,
                None => self.qcol(s, &o.column),
            };
            parts.push(format!("{col} {}", if o.desc { "DESC" } else { "ASC" }));
        }
        Ok(format!(" ORDER BY {}", parts.join(", ")))
    }

    fn render_group_by(&self, s: &Scope<'_>, q: &ir::Query) -> Result<String> {
        let mut parts: Vec<String> = q.group_by.iter().map(|g| self.qcol(s, g)).collect();
        for g in &q.group_by_expr {
            parts.push(self.render_expr(s, &g.expr)?);
        }
        Ok(parts.join(", "))
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
            let col = s.ent.column(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", s.ent.name)))?;
            let expr = self.d.read_expr(&self.qcol(s, name), &col.typ, &self.sql_styles(&col.styles));
            let out = OutCol { name: name.clone(), column: name.clone(), typ: col.typ.clone(), styles: self.app_styles(&col.styles), ..Default::default() };
            push(sb, expr, name, out, asm);
        }
        for g in &s.q.group_by_expr {
            let expr = self.render_expr(s, &g.expr)?;
            let typ = s.ent.column(&g.as_).map(|c| c.typ.clone()).unwrap_or_else(|| "string".into());
            push(sb, expr, &g.as_, OutCol { name: g.as_.clone(), typ, ..Default::default() }, asm);
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
            let mut col = s.ent.column(&c.column);
            if col.map(is_aes).unwrap_or(false) {
                has_aes = true;
            }
            sep(sb);
            let mut styles = Vec::new();
            let mut typ = "string".to_owned();
            let expr = match c.kind {
                OutKind::Fn(f) => {
                    let e = self.column_function(b, s, &c.column, f)?;
                    typ = function_type(&f.name, col);
                    col = None;
                    e
                }
                OutKind::Sub(sub) => {
                    let e = self.sub_select(b, s, sub)?;
                    typ = self.sub_type(sub)?;
                    format!("({e})")
                }
                OutKind::Expr(x) => {
                    let e = self.render_expr(s, &x.sql)?;
                    b.fill(&e, &x.ps)?
                }
                OutKind::Column => {
                    let col = col.ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{}", s.ent.name, c.column)))?;
                    styles = self.app_styles(&col.styles);
                    self.d.read_expr(&self.qcol(s, &c.column), &col.typ, &self.sql_styles(&col.styles))
                }
            };
            let out = format!("{}__{}", s.alias, c.name);
            sb.push_str(&format!("{expr} AS {}", self.d.quote(&out)));
            out_names.push(out);
            if let Some(col) = col {
                typ = col.typ.clone();
            }
            asm.columns.push(OutCol { index: out_names.len() - 1, name: c.name, column: c.column, typ, styles, hidden: false });
        }
        if has_aes {
            let version =
                s.ent.column("aes_key_version").ok_or_else(|| err(codes::SCHEMA_INVALID, format!("{}: AES column requires aes_key_version", s.ent.name)))?;
            sep(sb);
            let out = format!("{}__{}", s.alias, version.name);
            sb.push_str(&format!("{} AS {}", self.qcol(s, &version.name), self.d.quote(&out)));
            out_names.push(out);
            asm.columns.push(OutCol {
                index: out_names.len() - 1,
                name: version.name.clone(),
                column: version.name.clone(),
                typ: version.typ.clone(),
                styles: Vec::new(),
                hidden: true,
            });
        }
        for j in &s.q.joins {
            let js = s.join(&j.rel).expect("scoped join");
            let mut child = Asm { entity: js.ent.name.clone(), alias: js.alias.clone(), ..Default::default() };
            self.select_list(b, js, sb, &mut child, out_names)?;
            asm.children.push(Ch { child: Child { rel: j.rel.clone(), kind: "join".into(), ..Default::default() }, asm: Some(child) });
        }
        asm.key = asm.key_refs(&s.ent.pk)?;
        Ok(())
    }

    /// Resolves the column mode, additions, and removals into an ordered list.
    fn projection<'q>(&self, s: &Scope<'q>) -> Result<Vec<OutItem<'q>>> {
        let c = s.q.columns.as_ref();
        let mode = c.map(|c| c.mode.as_str()).unwrap_or("");
        let mut base: Vec<String> = s
            .ent
            .columns
            .iter()
            .filter(|col| match mode {
                "all" => true,
                "none" => col.pk || col.fk,
                _ => !col.lazy,
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
                base.retain(|x| !c.remove.contains(x) || s.ent.column(x).map(|col| col.pk).unwrap_or(false));
            }
        }
        for x in &s.extra {
            add(&mut base, x);
        }
        for r in &s.q.relations {
            if !r.left.is_empty() {
                add(&mut base, &r.left);
            } else if let Some(rel) = s.ent.relations.get(&r.rel) {
                for k in &rel.keys {
                    add(&mut base, &k.local);
                }
            }
            if let Some(ip) = &r.query.if_parent {
                add(&mut base, &ip.column);
            }
        }
        for pk in &s.ent.pk {
            if !base.contains(pk) {
                base.insert(0, pk.clone());
            }
        }
        let mut out: Vec<OutItem<'q>> = base.into_iter().map(|x| OutItem { name: x.clone(), column: x, kind: OutKind::Column }).collect();
        if let Some(c) = c {
            for (name, e) in &c.expr {
                out.push(OutItem { name: name.clone(), column: String::new(), kind: OutKind::Expr(e) });
            }
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
            let conditions: Vec<String> = if !j.left.is_empty() {
                vec![format!("{} = {}", self.qcol(s, &j.left), self.qcol(js, &j.right))]
            } else {
                let rel = s.ent.relations.get(&j.rel).ok_or_else(|| err(codes::RELATION_UNKNOWN, format!("{}.{}", s.ent.name, j.rel)))?;
                rel.keys.iter().map(|k| format!("{} = {}", self.qcol(s, &k.local), self.qcol(js, &k.target))).collect()
            };
            sb.push_str(&format!("{kw}{} AS {} ON {}", self.d.quote(&js.ent.table), self.d.quote(&js.alias), conditions.join(" AND ")));
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
        Ok(if top { out } else { format!("({out})") })
    }

    fn render_pred(&self, b: &mut Builder, root: &Scope<'_>, s: &Scope<'_>, pr: &ir::Pred) -> Result<String> {
        if !pr.op.is_empty() && !self.d.supports(&pr.op) {
            return Err(err(codes::OPERATOR_NOT_ALLOWED, format!("{} is not available on {}", pr.op, self.d.name())));
        }
        if !pr.expr.is_empty() {
            let e = self.render_expr(s, &pr.expr)?;
            return Ok(format!("({})", b.fill(&e, &pr.ps)?));
        }
        let p = || pr.p.ok_or_else(|| err(codes::IR_INVALID, format!("{} {}.{} needs a value (p)", pr.op, s.ent.name, pr.column)));
        match pr.op.as_str() {
            "match" | "match_boolean" => {
                let cols: Vec<String> = pr.match_.iter().map(|c| self.qcol(s, c)).collect();
                let boolean = pr.op == "match_boolean";
                let ph = b.param_t(p()?, if boolean { "fulltext_boolean" } else { "" });
                return Ok(self.d.fulltext(&cols, &ph, boolean));
            }
            "tuple_in" | "tuple_not_in" => {
                let cols = self.qualified(s, &pr.cols);
                let mut rows = Vec::new();
                for chunk in pr.ps.chunks(pr.cols.len()) {
                    let mut row = Vec::with_capacity(chunk.len());
                    for (k, name) in pr.cols.iter().enumerate() {
                        let col = s.ent.column(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", s.ent.name)))?;
                        row.push(self.render_value(b, col, chunk[k]));
                    }
                    rows.push(row);
                }
                return Ok(self.d.tuple_in(&cols, &rows, pr.op == "tuple_not_in"));
            }
            _ => {}
        }
        let col = s.ent.column(&pr.column).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{}", s.ent.name, pr.column)))?;
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
                Some(i) => cell.borrow_mut().param(i),
                None => String::new(),
            };
            let mut now = || cell.borrow_mut().now();
            let value = self
                .d
                .value_function(&v.name, &mut arg, &mut now)
                .ok_or_else(|| err(codes::CAPABILITY_UNSUPPORTED, format!("{} is not available on {}", v.name, self.d.name())))?;
            return Ok(format!("{lhs} {} {value}", cmp(&pr.op)));
        }
        if let Some(f) = &pr.r#fn {
            let fcol = self.column_function(b, s, &pr.column, f)?;
            return Ok(match pr.op.as_str() {
                "in" | "not_in" => {
                    let phs: Vec<String> = pr.ps.iter().map(|i| b.param(*i)).collect();
                    let op = if pr.op == "not_in" { " NOT IN " } else { " IN " };
                    format!("{fcol}{op}({})", phs.join(", "))
                }
                "between" => {
                    let lo = b.param(pr.ps[0]);
                    let hi = b.param(pr.ps[1]);
                    format!("{fcol} BETWEEN {lo} AND {hi}")
                }
                _ => format!("{fcol} {} {}", cmp(&pr.op), b.param(p()?)),
            });
        }
        let op = pr.op.as_str();
        Ok(match op {
            "eq" | "not_eq" | "gt" | "gte" | "lt" | "lte" => {
                if is_aes(col) {
                    if op != "eq" && op != "not_eq" {
                        return Err(err(codes::OPERATOR_NOT_ALLOWED, "AES columns support only equality through a declared blind index"));
                    }
                    lhs = self.blind_lhs(s, col)?;
                    let rhs = self.blind_value(b, p()?);
                    return Ok(format!("{lhs} {} {rhs}", cmp(op)));
                }
                let rhs = self.render_value(b, col, p()?);
                format!("{lhs} {} {rhs}", cmp(op))
            }
            "eq_col" | "not_eq_col" | "gt_col" | "gte_col" | "lt_col" | "lte_col" => {
                let r = pr.r#ref.as_ref().ok_or_else(|| err(codes::IR_INVALID, format!("{op} needs ref")))?;
                let rs = self.resolve_path(root, &r.path)?;
                if rs.ent.column(&r.column).is_none() {
                    return Err(err(codes::COLUMN_UNKNOWN, format!("{}.{}", rs.ent.name, r.column)));
                }
                format!("{lhs} {} {}", cmp(op.trim_end_matches("_col")), self.qcol(rs, &r.column))
            }
            "in" | "not_in" => {
                let aes = is_aes(col);
                if aes {
                    lhs = self.blind_lhs(s, col)?;
                }
                let phs: Vec<String> = pr.ps.iter().map(|i| if aes { self.blind_value(b, *i) } else { self.render_value(b, col, *i) }).collect();
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
                let ph = b.param_t(p()?, "like_contains");
                self.d.like(&lhs, &ph)
            }
            "contains_binary" => {
                let i = p()?;
                self.d.contains_binary(&lhs, &mut |t| b.param_t(i, t))
            }
            _ => return Err(err(codes::OPERATOR_UNKNOWN, op.to_owned())),
        })
    }

    fn blind_lhs(&self, s: &Scope<'_>, col: &ColumnSchema) -> Result<String> {
        if col.blind_index.is_empty() {
            return Err(err(codes::IR_INVALID, format!("{}.{} requires a declared blind index for equality search", s.ent.name, col.name)));
        }
        Ok(self.qcol(s, &col.blind_index))
    }

    /// Binds plaintext for executor-side keyed hashing.
    fn blind_value(&self, b: &mut Builder, i: usize) -> String {
        b.slot(BindSlot { from: "param".into(), param: i, host_styles: vec!["blind_index".into()], ..Default::default() })
    }

    /// Binds one value, wrapped in the SQL-side stages of the column; the
    /// stages the dialect leaves to the executor are recorded on the slot.
    fn render_value(&self, b: &mut Builder, col: &ColumnSchema, i: usize) -> String {
        let styles = self.sql_styles(&col.styles);
        let host: Vec<String> = col.styles.iter().filter(|s| matches!(s.as_str(), "aes" | "hex" | "ip") && !self.d.handles_style(s)).cloned().collect();
        let ph = b.slot(BindSlot { from: "param".into(), param: i, host_styles: host, col_type: bind_type(col), ..Default::default() });
        if styles.is_empty() && col.typ != "point" {
            return ph;
        }
        self.d.write_expr(ph, &col.typ, &styles)
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

    /// Checks the `{column}` and backtick references of a fragment and
    /// qualifies them with the scope alias.
    fn render_expr(&self, s: &Scope<'_>, frag: &str) -> Result<String> {
        let frag = frag.replace(CURRENT_TIME_TOKEN, self.d.current_time());
        let mut out = String::with_capacity(frag.len());
        let mut rest = frag.as_str();
        while let Some(i) = rest.find(['{', '`']) {
            out.push_str(&rest[..i]);
            let close = if rest.as_bytes()[i] == b'{' { '}' } else { '`' };
            let after = &rest[i + 1..];
            let j = after.find(close).ok_or_else(|| err(codes::IR_INVALID, format!("unterminated {} in expr", &rest[i..i + 1])))?;
            let name = &after[..j];
            if s.ent.column(name).is_none() {
                return Err(err(codes::COLUMN_UNKNOWN, format!("{}.{name} in expr", s.ent.name)));
            }
            out.push_str(&self.qcol(s, name));
            rest = &after[j + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    fn column_function(&self, b: &mut Builder, s: &Scope<'_>, column: &str, f: &ir::Func) -> Result<String> {
        self.d
            .column_function(&f.name, &self.qcol(s, column), &mut |i| b.param(f.ps[i]))
            .ok_or_else(|| err(codes::CAPABILITY_UNSUPPORTED, format!("{} is not available on {}", f.name, self.d.name())))
    }

    /// A subquery for an IN list or a scalar column; its root gets its own
    /// alias and resolves "^" against `outer`.
    fn sub_select(&self, b: &mut Builder, outer: &Scope<'_>, sub: &ir::Sub) -> Result<String> {
        b.subs += 1;
        let mut root = self.scopes(&sub.query, format!("s{}", b.subs), false)?;
        // SAFETY of lifetimes: the subquery scope never outlives `outer`.
        let outer: &Scope<'_> = outer;
        root.outer = Some(unsafe { std::mem::transmute::<&Scope<'_>, &Scope<'_>>(outer) });
        let root = &root;
        let mut sb = String::from("SELECT ");
        match sub.agg.as_str() {
            "sum" => sb.push_str(&format!("COALESCE(SUM({}), 0)", self.qcol(root, &sub.column))),
            "avg" => sb.push_str(&format!("AVG({})", self.qcol(root, &sub.column))),
            "count" => sb.push_str("COUNT(*)"),
            _ => sb.push_str(&self.qcol(root, &sub.column)),
        }
        sb.push_str(&format!(" FROM {} AS {}", self.d.quote(&root.ent.table), self.d.quote(&root.alias)));
        self.render_joins(b, root, root, &mut sb)?;
        let mut where_ = Vec::new();
        if !root.ent.soft_delete.is_empty() {
            where_.push(format!("{} IS NULL", self.qcol(root, &root.ent.soft_delete)));
        }
        if let Some(w) = sub.query.where_.as_ref().filter(|g| !g.items.is_empty()) {
            where_.push(self.render_group(b, root, root, w, true)?);
        }
        self.collect_join_where(b, root, root, &mut where_)?;
        if !where_.is_empty() {
            sb.push_str(" WHERE ");
            sb.push_str(&where_.join(" AND "));
        }
        if !sub.query.group_by.is_empty() {
            sb.push_str(" GROUP BY ");
            sb.push_str(&self.render_group_by(root, &sub.query)?);
        }
        Ok(sb)
    }

    fn sub_type(&self, sub: &ir::Sub) -> Result<String> {
        Ok(match sub.agg.as_str() {
            "count" => "i64".into(),
            "avg" => "f64".into(),
            _ => self.entity(&sub.query.entity)?.column(&sub.column).map(|c| c.typ.clone()).unwrap_or_else(|| "string".into()),
        })
    }

    fn table_scope<'a>(&self, ent: &'a EntitySchema, q: &'a ir::Query) -> Result<Scope<'a>>
    where
        'm: 'a,
    {
        self.scopes(q, ent.table.clone(), false)
    }

    fn render_assign(&self, b: &mut Builder, ent: &EntitySchema, col: &ColumnSchema, a: &ir::Assign) -> Result<String> {
        if blind_index_source(ent, &col.name).is_some() {
            if !a.expr.is_empty() || a.plus_p.is_some() || a.minus_p.is_some() {
                return Err(err(codes::IR_INVALID, "blind index assignment must use its AES source value"));
            }
            if a.null {
                return Ok("NULL".into());
            }
            return Ok(self.blind_value(b, a.p.unwrap_or_default()));
        }
        let qualified = || format!("{}.{}", self.d.quote(&ent.table), self.d.quote(&col.name));
        if !a.expr.is_empty() {
            let empty = ir::Query::default();
            let scope = Scope { ent, alias: ent.table.clone(), q: &empty, joins: Vec::new(), outer: None, extra: Vec::new() };
            let e = self.render_expr(&scope, &a.expr)?;
            return b.fill(&e, &a.ps);
        }
        if let Some(i) = a.plus_p {
            // table-qualified: inside ON CONFLICT DO UPDATE a bare name is ambiguous
            return Ok(format!("{} + {}", qualified(), b.param(i)));
        }
        if let Some(i) = a.minus_p {
            let q = qualified();
            let first = b.param(i);
            let second = b.param(i);
            return Ok(format!("CASE WHEN {q} > {first} THEN {q} - {second} ELSE 0 END"));
        }
        if a.null {
            return Ok("NULL".into());
        }
        let p = a.p.ok_or_else(|| err(codes::IR_INVALID, format!("set {}: exactly one of p/null/expr/plus_p/minus_p", a.column)))?;
        Ok(self.render_value(b, col, p))
    }

    fn column_of<'e>(&self, ent: &'e EntitySchema, name: &str) -> Result<&'e ColumnSchema> {
        ent.column(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", ent.name)))
    }

    fn insert_step(&self, r: &ir::Request) -> Result<Step> {
        let mut b = Builder::new(self.d);
        let ent = self.entity(&r.query.entity)?;
        let set = add_blind_index_assignments(ent, r.set.clone());
        validate_aes_assignments(ent, &set, false)?;
        validate_required_assignments(ent, &set)?;
        let version = aes_version_column(ent);
        let mut cols = Vec::new();
        let mut vals = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            if col.auto {
                return Err(err(codes::IR_INVALID, format!("cannot set auto column {}", a.column)));
            }
            cols.push(self.d.quote(&a.column));
            vals.push(self.render_assign(&mut b, ent, col, a)?);
        }
        if !version.is_empty() && !assigned(&set, version) {
            cols.push(self.d.quote(version));
            vals.push(b.config("aes_version"));
        }
        // A dialect without a session time zone stores the executor clock,
        // which is in the connection time zone, instead of its UTC default.
        let now_cols: Vec<&str> = if self.d.host_now() {
            ent.columns.iter().filter(|c| c.default.as_deref() == Some("now") && !assigned(&set, &c.name)).map(|c| c.name.as_str()).collect()
        } else {
            Vec::new()
        };
        for c in &now_cols {
            cols.push(self.d.quote(c));
            vals.push(b.now());
        }
        let mut sql = format!("INSERT INTO {} ({}) VALUES ({})", self.d.quote(&ent.table), cols.join(", "), vals.join(", "));
        if !r.rows.is_empty() {
            // each rendered column maps to its value in r.set; a derived blind
            // index takes the value of its AES source column
            let mut source = Vec::with_capacity(set.len());
            for (i, a) in set.iter().enumerate() {
                if i < r.set.len() {
                    source.push(i);
                } else {
                    let src = blind_index_source(ent, &a.column).map(|c| c.name.as_str()).unwrap_or("");
                    source.push(r.set.iter().position(|x| x.column == src).unwrap_or(0));
                }
            }
            for row in &r.rows {
                let mut more = Vec::with_capacity(set.len() + 1);
                for (i, a) in set.iter().enumerate() {
                    let assign = ir::Assign { column: a.column.clone(), p: Some(row[source[i]]), ..Default::default() };
                    more.push(self.render_assign(&mut b, ent, self.column_of(ent, &a.column)?, &assign)?);
                }
                if !version.is_empty() && !assigned(&set, version) {
                    more.push(b.config("aes_version"));
                }
                for _ in &now_cols {
                    more.push(b.now());
                }
                sql.push_str(&format!(", ({})", more.join(", ")));
            }
            return Ok(Step { role: "main".into(), sql, bind_slots: b.binds, ..Default::default() });
        }
        if !r.on_duplicate.is_empty() {
            let duplicate = add_blind_index_assignments(ent, r.on_duplicate.clone());
            validate_aes_assignments(ent, &duplicate, true)?;
            let mut sets = Vec::new();
            for a in &duplicate {
                let v = self.render_assign(&mut b, ent, self.column_of(ent, &a.column)?, a)?;
                sets.push(format!("{} = {v}", self.d.quote(&a.column)));
            }
            if !version.is_empty() && assigns_aes(ent, &duplicate) && !assigned(&duplicate, version) {
                sets.push(format!("{} = {}", self.d.quote(version), b.config("aes_version")));
            }
            if !ent.auto.is_empty() && !self.d.insert_returning_id() {
                // MySQL: make the last insert id report the existing row
                let auto = self.d.quote(&ent.auto);
                sets.push(format!("{auto} = LAST_INSERT_ID({auto})"));
            }
            sql.push_str(&self.d.upsert(&conflict_target(ent, &set), &sets.join(", ")));
        }
        if self.d.insert_returning_id() && !ent.auto.is_empty() {
            sql.push_str(&format!(" RETURNING {}", self.d.quote(&ent.auto)));
        }
        Ok(Step { role: "main".into(), sql, bind_slots: b.binds, ..Default::default() })
    }

    fn update_step(&self, r: &ir::Request) -> Result<Step> {
        let mut b = Builder::new(self.d);
        let ent = self.entity(&r.query.entity)?;
        let set = add_blind_index_assignments(ent, r.set.clone());
        validate_aes_assignments(ent, &set, true)?;
        let root = self.table_scope(ent, &r.query)?;
        let mut sets = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            if col.pk || col.auto {
                return Err(err(codes::IR_INVALID, format!("cannot update {}", a.column)));
            }
            let v = self.render_assign(&mut b, ent, col, a)?;
            sets.push(format!("{} = {v}", self.d.quote(&a.column)));
        }
        let version = aes_version_column(ent);
        if !version.is_empty() && assigns_aes(ent, &set) && !assigned(&set, version) {
            sets.push(format!("{} = {}", self.d.quote(version), b.config("aes_version")));
        }
        // The updated timestamp is always assigned explicitly, so every
        // dialect and optimistic locking behave the same.
        let updated = ent.updated_column();
        if !updated.is_empty() && !assigned(&r.set, updated) {
            if let Some(col) = ent.column(updated) {
                let now = if self.d.host_now() {
                    b.now()
                } else if col.precision > 0 && self.d == Dialect::MySql {
                    format!("CURRENT_TIMESTAMP({})", col.precision)
                } else {
                    self.d.now().to_owned()
                };
                sets.push(format!("{} = {now}", self.d.quote(updated)));
            }
        }
        let w = r.query.where_.as_ref().filter(|g| !g.items.is_empty()).ok_or_else(|| err(codes::IR_INVALID, "update without where"))?;
        let mut where_ = self.render_group(&mut b, &root, &root, w, true)?;
        if let Some(o) = &r.optimistic {
            let ph = b.param(o.p);
            where_.push_str(&format!(" AND {} = {ph}", self.qcol(&root, &o.column)));
        }
        if !ent.soft_delete.is_empty() {
            where_.push_str(&format!(" AND {} IS NULL", self.qcol(&root, &ent.soft_delete)));
        }
        let sql = format!("UPDATE {} SET {} WHERE {where_}", self.d.quote(&ent.table), sets.join(", "));
        Ok(Step { role: "main".into(), sql, bind_slots: b.binds, ..Default::default() })
    }

    fn delete_step(&self, r: &ir::Request) -> Result<Step> {
        let mut b = Builder::new(self.d);
        let ent = self.entity(&r.query.entity)?;
        let root = self.table_scope(ent, &r.query)?;
        let now = if ent.soft_delete.is_empty() {
            String::new()
        } else if self.d.host_now() {
            b.now()
        } else {
            self.d.now().to_owned()
        };
        let w = r.query.where_.as_ref().filter(|g| !g.items.is_empty()).ok_or_else(|| err(codes::IR_INVALID, "delete without where"))?;
        let mut where_ = self.render_group(&mut b, &root, &root, w, true)?;
        let sql = if !ent.soft_delete.is_empty() {
            where_.push_str(&format!(" AND {} IS NULL", self.qcol(&root, &ent.soft_delete)));
            format!("UPDATE {} SET {} = {now} WHERE {where_}", self.d.quote(&ent.table), self.d.quote(&ent.soft_delete))
        } else {
            format!("DELETE FROM {} WHERE {where_}", self.d.quote(&ent.table))
        };
        Ok(Step { role: "main".into(), sql, bind_slots: b.binds, ..Default::default() })
    }
}

enum OutKind<'q> {
    Column,
    Expr(&'q ir::Expr),
    Fn(&'q ir::Func),
    Sub(&'q ir::Sub),
}

struct OutItem<'q> {
    name: String,
    column: String,
    kind: OutKind<'q>,
}
