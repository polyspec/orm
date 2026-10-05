//! Turns a validated request into a plan: one statement per step, relations
//! as separate steps bound to the rows of their parent step.

use std::sync::Arc;

use super::dialect::{Dialect, CURRENT_TIME_TOKEN};
use super::err;
use crate::codes;
use crate::ir;
use crate::plan::{Assemble, BindSlot, Child, IfParent, KeyRef, OutCol, ParentRef, Plan, Step};
use crate::schema::Manifest;
use crate::Result;
use orm_schema::dbspec::{Entity, Field, FieldDefault, Type};

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
    /// statement가 이름으로 쓴 table이다.
    tables: std::collections::BTreeSet<String>,
    /// type 없는 slot처럼 placeholder를 만들며 생긴 첫 planner 오류다. step을 만드는 곳이 확인한다.
    error: Option<crate::Error>,
}

impl Builder {
    fn new(d: Dialect) -> Builder {
        Builder { d, binds: Vec::new(), subs: 0, tables: std::collections::BTreeSet::new(), error: None }
    }

    /// placeholder를 만들며 생긴 첫 오류를 돌려준다.
    fn checked(&mut self) -> Result<()> {
        match self.error.take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// table 이름을 quote하고 statement의 table로 기록한다.
    fn table(&mut self, table: &str) -> String {
        self.tables.insert(table.to_string());
        self.d.quote(table)
    }

    /// statement가 쓴 table을 정렬해 돌려준다.
    fn tables(&self) -> Vec<String> {
        self.tables.iter().cloned().collect()
    }

    fn push(&mut self, slot: BindSlot) -> String {
        self.binds.push(slot);
        self.d.placeholder(self.binds.len())
    }

    /// type 있는 slot을 더한다. type 없는 slot은 planner 오류다.
    fn slot(&mut self, slot: BindSlot) -> String {
        if slot.col_type.is_empty() && self.error.is_none() {
            self.error = Some(err(codes::IR_INVALID, format!("bind slot {} ({}) has no declared type", self.binds.len(), slot.from)));
        }
        self.push(slot)
    }

    /// request 값 Params[i]의 placeholder다. `ty`는 그 값의 dbspec type이다.
    fn param(&mut self, i: usize, ty: &str) -> String {
        self.slot(BindSlot { from: "param".into(), param: i, col_type: ty.into(), ..Default::default() })
    }

    /// column `col`과 비교하거나 `col`에 할당하는 값 Params[i]의 placeholder다. type은 `col`의
    /// type이고 decimal, time, datetime은 그 자릿수를 싣는다.
    fn col_param(&mut self, i: usize, col: &Field, transform: &str) -> String {
        let (precision, scale) = col_digits(col);
        self.slot(BindSlot {
            from: "param".into(),
            param: i,
            transform: transform.into(),
            col_type: col.ty.name().into(),
            precision,
            scale,
            ..Default::default()
        })
    }

    /// raw fragment의 `?`가 받는 값이다. planner는 사용자 SQL이 그 값을 어디에 쓰는지 모르므로
    /// type이 없다. raw fragment는 G5.32-3에서 사라진다.
    fn raw_param(&mut self, i: usize) -> String {
        self.push(BindSlot { from: "param".into(), param: i, ..Default::default() })
    }

    /// executor 설정 값이다. `ty`는 그 값을 쓰는 column의 type이다.
    fn config(&mut self, name: &str, ty: &str) -> String {
        self.slot(BindSlot { from: "config".into(), name: name.into(), col_type: ty.into(), ..Default::default() })
    }

    /// executor가 주는 시각. `precision`은 slot의 소수 자리다(`clock_precision`).
    fn now(&mut self, precision: u8) -> String {
        self.slot(BindSlot { from: "now".into(), precision: precision.into(), col_type: "datetime".into(), ..Default::default() })
    }

    /// executor가 채우는 transaction의 audit 기록 key다. name은 audit 기록 entity이며, executor는
    /// transaction의 audit이 그 entity의 행인지 확인한다. type은 audit column의 type이다.
    fn audit(&mut self, col: &Field, record: &str) -> String {
        let ph = self.slot(BindSlot { from: "audit".into(), name: record.to_owned(), col_type: col.ty.name().into(), ..Default::default() });
        self.d.write_expr(ph, col.ty, &[])
    }

    /// executor가 parent 값으로 펼치는 placeholder 하나다. `key_types`는 비교하는 key column의 type이다.
    fn parent_list(&mut self, step: usize, key_types: Vec<String>) -> String {
        self.push(BindSlot { from: "parent".into(), step: step as u32, key_types, ..Default::default() })
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
                let ph = self.raw_param(ps[k]);
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

/// AES 값과 함께 쓰는 key version column (`aes_version` setting).
fn aes_version_column(ent: &Entity) -> &str {
    ent.aes_version.as_deref().unwrap_or("")
}

/// executor가 transaction의 audit 기록 key를 쓰는 audit column.
fn audit_column(ent: &Entity) -> &str {
    ent.audit.as_ref().map(|a| a.column.as_str()).unwrap_or("")
}

/// audit column이 가리키는 audit 기록 entity.
fn audit_record(ent: &Entity) -> &str {
    ent.audit.as_ref().map(|a| a.record.as_str()).unwrap_or("")
}

fn assigned(set: &[ir::Assign], col: &str) -> bool {
    set.iter().any(|a| a.column == col)
}

fn assigns_aes(ent: &Entity, set: &[ir::Assign]) -> bool {
    set.iter().any(|a| ent.field(&a.column).map(Field::aes).unwrap_or(false))
}

/// executor만 쓰는 audit column을 request가 직접 쓰면 거부한다.
fn validate_audit_assignment(ent: &Entity, set: &[ir::Assign]) -> Result<()> {
    let audited = audit_column(ent);
    if !audited.is_empty() && assigned(set, audited) {
        return Err(err(codes::IR_INVALID, format!("{}.{audited} is written by the executor from the audit of the transaction", ent.name)));
    }
    Ok(())
}

/// `datetime(p)` column의 p.
fn datetime_precision(col: &Field) -> u8 {
    match col.ty {
        Type::DateTime(p) => p,
        _ => 0,
    }
}

/// column에 쓰거나 column과 비교하는 `now` slot의 소수 자리: `datetime(p)` column은 p,
/// 그 밖의 column은 6이다. executor는 한 statement의 clock을 slot마다 이 자리로 버린다.
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

/// insert는 필요한 column을 모두 쓴다: default가 없는 NOT NULL column 중 identity,
/// planner가 쓰는 AES key version, executor가 쓰는 audit column이 아닌 것.
/// default가 있는 column을 빼면 database default를 쓴다.
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

fn add_blind_index_assignments(ent: &Entity, mut set: Vec<ir::Assign>) -> Vec<ir::Assign> {
    for a in set.clone() {
        let Some(col) = ent.field(&a.column) else { continue };
        let Some(index) = col.blind_index.as_ref().filter(|_| col.aes()) else { continue };
        if assigned(&set, index) {
            continue;
        }
        set.push(ir::Assign { column: index.clone(), p: a.p, null: a.null, ..Default::default() });
    }
    set
}

fn blind_index_source<'e>(ent: &'e Entity, target: &str) -> Option<&'e Field> {
    ent.fields.iter().find(|c| c.blind_index.as_deref() == Some(target))
}

/// The unique key an upsert conflicts on: the first declared unique key whose
/// columns are all inserted, else the primary key.
fn conflict_target(ent: &Entity, set: &[ir::Assign]) -> Vec<String> {
    for uk in &ent.uniques {
        if uk.columns.iter().all(|c| assigned(set, c)) {
            return uk.columns.clone();
        }
    }
    ent.primary_key.clone()
}

/// column 값 slot이 싣는 precision과 scale이다: decimal(p,s), time(p), datetime(p).
fn col_digits(col: &Field) -> (i64, i64) {
    match col.ty {
        Type::Decimal(p, s) => (p.into(), s.into()),
        Type::Time(p) | Type::DateTime(p) => (p.into(), 0),
        _ => (0, 0),
    }
}

/// SQL 쪽 style 함수가 placeholder에서 받는 값의 type이다. hex는 byte를, ip는 IP 주소 text를 받는다.
fn style_input_type(style: &str) -> &'static str {
    if style == "ip" {
        "text"
    } else {
        "bytes"
    }
}

/// 상대 시각 함수가 받는 간격 값의 type이다. 초는 소수를, 나머지 단위는 정수를 받는다.
fn value_function_arg_type(name: &str) -> &'static str {
    if super::dialect::value_function_unit(name) == Some("second") {
        "f64"
    } else {
        "i32"
    }
}

fn function_type(name: &str, col: Option<&Field>) -> String {
    match name {
        "day_of_week" | "year" | "month" => "i64".into(),
        "date" => "date".into(),
        _ => col.map(|c| c.ty.name().to_owned()).unwrap_or_else(|| "varchar".into()),
    }
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

    fn client_styles(&self, styles: &[String]) -> Vec<String> {
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
            if !o.expr.is_empty() {
                // a raw order expression carries its own direction
                parts.push(self.render_expr(s, &o.expr)?);
                continue;
            }
            let col = match &o.r#fn {
                Some(f) => self.column_function(s, &o.column, f)?,
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
            let col = s.ent.field(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", s.ent.name)))?;
            let expr = self.d.read_expr(&self.qcol(s, name), col.ty, &self.sql_styles(&col.codec));
            let out =
                OutCol { name: name.clone(), column: name.clone(), typ: col.ty.name().into(), styles: self.client_styles(&col.codec), ..Default::default() };
            push(sb, expr, name, out, asm);
        }
        for g in &s.q.group_by_expr {
            let expr = self.render_expr(s, &g.expr)?;
            let typ = s.ent.field(&g.as_).map(|c| c.ty.name().to_owned()).unwrap_or_else(|| "varchar".into());
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
                OutKind::Expr(x) => {
                    let e = self.render_expr(s, &x.sql)?;
                    b.fill(&e, &x.ps)?
                }
                OutKind::Column => {
                    let col = col.ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{}", s.ent.name, c.column)))?;
                    styles = self.client_styles(&col.codec);
                    self.d.read_expr(&self.qcol(s, &c.column), col.ty, &self.sql_styles(&col.codec))
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
            // 고른 version column이 있으면 그것을 쓰고, 없을 때만 숨겨서 읽는다.
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
            let condition = format!("{} = {}", self.qcol(s, &j.left), self.qcol(js, &j.right));
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
        Ok(if top { out } else { format!("({out})") })
    }

    fn render_pred(&self, b: &mut Builder, root: &Scope<'_>, s: &Scope<'_>, pr: &ir::Pred) -> Result<String> {
        if !pr.expr.is_empty() {
            let e = self.render_expr(s, &pr.expr)?;
            return Ok(format!("({})", b.fill(&e, &pr.ps)?));
        }
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
                Some(i) => cell.borrow_mut().param(i, value_function_arg_type(&v.name)),
                None => String::new(),
            };
            let precision = clock_precision(col);
            let mut now = || cell.borrow_mut().now(precision);
            let value = self
                .d
                .value_function(&v.name, &mut arg, &mut now)
                .ok_or_else(|| err(codes::CAPABILITY_UNSUPPORTED, format!("{} is not available on {}", v.name, self.d.name())))?;
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
        // SQL 쪽 style 함수가 감싸는 값의 type은 그 함수 입력의 type이다.
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
            if s.ent.field(name).is_none() {
                return Err(err(codes::COLUMN_UNKNOWN, format!("{}.{name} in expr", s.ent.name)));
            }
            out.push_str(&self.qcol(s, name));
            rest = &after[j + 1..];
        }
        out.push_str(rest);
        Ok(out)
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
            if !a.expr.is_empty() || a.plus_p.is_some() || a.minus_p.is_some() {
                return Err(err(codes::IR_INVALID, "blind index assignment must use its AES source value"));
            }
            if a.null {
                return Ok("NULL".into());
            }
            return Ok(self.blind_value(b, col, a.p.unwrap_or_default()));
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
        let p = a.p.ok_or_else(|| err(codes::IR_INVALID, format!("set {}: exactly one of p/null/expr/plus_p/minus_p", a.column)))?;
        Ok(self.render_value(b, col, p))
    }

    fn column_of<'e>(&self, ent: &'e Entity, name: &str) -> Result<&'e Field> {
        ent.field(name).ok_or_else(|| err(codes::COLUMN_UNKNOWN, format!("{}.{name}", ent.name)))
    }

    fn insert_step(&self, r: &ir::Request) -> Result<Step> {
        let mut b = Builder::new(self.d);
        let ent = self.entity(&r.query.entity)?;
        let set = add_blind_index_assignments(ent, r.set.clone());
        validate_aes_assignments(ent, &set, false)?;
        validate_audit_assignment(ent, &set)?;
        validate_required_assignments(ent, &set)?;
        let version = aes_version_column(ent);
        let audited = audit_column(ent);
        let mut cols = Vec::new();
        let mut vals = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            if col.identity {
                return Err(err(codes::IR_INVALID, format!("cannot set identity column {}", a.column)));
            }
            cols.push(self.d.quote(&a.column));
            vals.push(self.render_assign(&mut b, ent, col, a)?);
        }
        // executor가 관리하는 column은 사용자 assignment 뒤에 AES key version, audit column,
        // `default now` 순서로 쓴다.
        let managed = self.managed_insert_columns(ent, &set)?;
        for c in &managed {
            cols.push(self.d.quote(c.column()));
            vals.push(c.value(&mut b));
        }
        let mut sql = format!("INSERT INTO {} ({}) VALUES ({})", b.table(&ent.table), cols.join(", "), vals.join(", "));
        if !r.rows.is_empty() {
            // 그려진 column은 r.set의 값에 대응한다. 파생된 blind index는 AES source column의 값을 쓴다.
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
            let duplicate = add_blind_index_assignments(ent, r.on_duplicate.clone());
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
                // MySQL: last insert id가 이미 있는 row를 가리키게 한다
                let identity = self.d.quote(identity);
                sets.push(format!("{identity} = LAST_INSERT_ID({identity})"));
            }
            sql.push_str(&self.d.upsert(&conflict_target(ent, &set), &sets.join(", ")));
        }
        if let Some(identity) = ent.identity.as_deref().filter(|_| self.d.insert_returning_id()) {
            sql.push_str(&format!(" RETURNING {}", self.d.quote(identity)));
        }
        b.checked()?;
        Ok(Step { role: "main".into(), sql, tables: b.tables(), bind_slots: b.binds, ..Default::default() })
    }

    /// insert가 사용자 assignment 외에 쓰는 column: AES key version, audit column,
    /// sub-second clock이 없는 dialect에서 assign되지 않은 `default now` column(field 순서).
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
        // SQLite database clock은 millisecond까지만 가지므로 `default now` column에 executor의
        // microsecond clock을 쓴다. MySQL과 PostgreSQL은 database default에 맡긴다.
        if self.d.host_now() {
            for f in &ent.fields {
                if matches!(f.default, Some(FieldDefault::Now)) && !assigned(set, &f.name) {
                    out.push(Managed::Now(f));
                }
            }
        }
        Ok(out)
    }

    /// updated와 soft delete가 `datetime(p)` column에 쓰는 statement 시각이다.
    /// sub-second clock이 없는 dialect는 executor의 microsecond clock을 bind하고,
    /// 나머지는 column의 소수 자리로 dialect의 database clock을 쓴다.
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
        let set = add_blind_index_assignments(ent, r.set.clone());
        validate_aes_assignments(ent, &set, true)?;
        validate_audit_assignment(ent, &set)?;
        let root = self.table_scope(ent, &r.query)?;
        let mut sets = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            if col.primary_key || col.identity {
                return Err(err(codes::IR_INVALID, format!("cannot update {}", a.column)));
            }
            let v = self.render_assign(&mut b, ent, col, a)?;
            sets.push(format!("{} = {v}", self.d.quote(&a.column)));
        }
        let version = aes_version_column(ent);
        if !version.is_empty() && assigns_aes(ent, &set) && !assigned(&set, version) {
            sets.push(format!("{} = {}", self.d.quote(version), b.config("aes_version", self.column_of(ent, version)?.ty.name())));
        }
        // updated 시각은 항상 명시적으로 쓰므로 모든 dialect와 optimistic locking이 같게 동작한다.
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

    /// soft delete column이 있으면 delete는 그 column을 statement 시각으로 쓰는 update다.
    /// audit 대상 table의 soft delete도 audit column을 쓴다.
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

    /// soft delete한 행 하나를 되돌리는 update다. where는 primary key나 unique key 하나의 모든 column을 eq
    /// 값으로 한 번씩 이름한다. 지워진 행만 고치므로 지워지지 않은 행과 없는 행은 아무것도 바꾸지 않는다.
    /// set은 되돌리는 행에 함께 쓰는 새 값이며 update처럼 쓴다. 그 뒤에 AES key version, soft delete column의
    /// NULL, audit table이면 audit column을 쓴다. updated column은 쓰지 않는다.
    fn restore_step(&self, r: &ir::Request) -> Result<Step> {
        let ent = self.entity(&r.query.entity)?;
        let Some(soft_delete) = &ent.soft_delete else {
            return Err(err(codes::IR_INVALID, format!("restore of {}, which has no soft_delete setting", ent.name)));
        };
        let w = r.query.where_.as_ref().filter(|g| !g.items.is_empty()).ok_or_else(|| err(codes::IR_INVALID, "restore without where"))?;
        restore_key(ent, w)?;
        let set = add_blind_index_assignments(ent, r.set.clone());
        validate_aes_assignments(ent, &set, true)?;
        validate_audit_assignment(ent, &set)?;
        let mut b = Builder::new(self.d);
        let root = self.table_scope(ent, &r.query)?;
        let mut sets = Vec::new();
        for a in &set {
            let col = self.column_of(ent, &a.column)?;
            if col.primary_key || col.identity || &col.name == soft_delete {
                return Err(err(codes::IR_INVALID, format!("restore cannot assign {}", a.column)));
            }
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
        let mut where_ = self.render_group(&mut b, &root, &root, w, true)?;
        where_.push_str(&format!(" AND {} IS NOT NULL", self.qcol(&root, soft_delete)));
        let sql = format!("UPDATE {} SET {} WHERE {where_}", b.table(&ent.table), sets.join(", "));
        b.checked()?;
        Ok(Step { role: "main".into(), sql, tables: b.tables(), bind_slots: b.binds, ..Default::default() })
    }
}

/// restore의 where가 primary key나 unique key 하나의 모든 column을 and로 이은 eq 값 조건으로 한 번씩
/// 이름하는지 확인한다.
fn restore_key(ent: &Entity, w: &ir::Group) -> Result<()> {
    let invalid =
        || err(codes::IR_INVALID, format!("restore of {} names every column of its primary key or of one unique key once with an eq value", ent.name));
    let mut columns: Vec<&str> = Vec::new();
    for (i, item) in w.items.iter().enumerate() {
        let ir::Item::Pred { pred } = item else {
            return Err(invalid());
        };
        if pred.op != "eq"
            || pred.p.is_none()
            || pred.r#fn.is_some()
            || pred.value.is_some()
            || pred.r#ref.is_some()
            || pred.sub.is_some()
            || !pred.expr.is_empty()
            || (i > 0 && pred.conn != "and")
            || columns.contains(&pred.column.as_str())
        {
            return Err(invalid());
        }
        columns.push(&pred.column);
    }
    let same_columns = |key: &[String]| key.len() == columns.len() && key.iter().all(|c| columns.contains(&c.as_str()));
    if same_columns(&ent.primary_key) || ent.uniques.iter().any(|k| same_columns(&k.columns)) {
        return Ok(());
    }
    Err(invalid())
}

/// insert마다 executor가 값을 주는 column과 그 bind slot.
enum Managed<'e> {
    AesVersion(&'e Field),
    /// audit column과 그 audit 기록 entity.
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
    Expr(&'q ir::Expr),
    Fn(&'q ir::Func),
    Sub(&'q ir::Sub),
}

struct OutItem<'q> {
    name: String,
    column: String,
    kind: OutKind<'q>,
}
