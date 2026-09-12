package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/template"

	"github.com/polyspec/orm/engine/schema"
)

// Rust generator: crate `gen` (clients/rust/gen) with one module per entity,
// against clients/rust/orm. Same grammar as Go/PHP (docs/dsl.md), snake_case.

var rustReserved = map[string]bool{"as": true, "break": true, "const": true, "continue": true, "crate": true, "else": true, "enum": true, "extern": true, "false": true, "fn": true, "for": true, "if": true, "impl": true, "in": true, "let": true, "loop": true, "match": true, "mod": true, "move": true, "mut": true, "pub": true, "ref": true, "return": true, "self": true, "Self": true, "static": true, "struct": true, "super": true, "trait": true, "true": true, "type": true, "unsafe": true, "use": true, "where": true, "while": true, "async": true, "await": true, "dyn": true}

func rustIdent(s string) string {
	if rustReserved[s] {
		return s + "_"
	}
	return s
}

func rustType(c *schema.Col) string {
	if len(appStyles(c)) > 0 {
		return "serde_json::Value"
	}
	switch c.Type {
	case "i32":
		return "i32"
	case "i64":
		return "i64"
	case "f64", "decimal":
		return "f64"
	case "bool":
		return "bool"
	case "datetime":
		return "chrono::NaiveDateTime"
	case "date":
		return "chrono::NaiveDate"
	default:
		return "String"
	}
}

func rustFrom(t string) string {
	switch t {
	case "i32":
		return "v.as_i64() as i32"
	case "i64":
		return "v.as_i64()"
	case "f64":
		return "v.as_f64()"
	case "bool":
		return "v.as_bool()"
	case "chrono::NaiveDateTime":
		return "v.as_datetime()"
	case "chrono::NaiveDate":
		return "v.as_date()"
	case "serde_json::Value":
		return "v.take_json().unwrap_or_default()"
	}
	return "v.take_string()"
}

// rustRead is the from_row read of a column from an orm::Cells source at index `i`.
func rustRead(t string) string {
	switch t {
	case "i32":
		return "src.i64(i)? as i32"
	case "i64":
		return "src.i64(i)?"
	case "f64":
		return "src.f64(i)?"
	case "bool":
		return "src.bool(i)?"
	case "chrono::NaiveDateTime":
		return "src.datetime(i)?"
	case "chrono::NaiveDate":
		return "src.date(i)?"
	}
	return "src.string(i)?"
}

type rustCol struct {
	goCol
	RType, From, Read, Ident string
	IsStr, IsJson            bool
}

type rustFinder struct {
	Method string
	Fields []rustCol
}

type rustRel struct {
	Name, Ident, Target, TargetType, Kind string
	Left, Right                           string
	Pair                                  bool
	Default                               bool
}

// rustPred is a manifest predicate: `visible()` / `started_after(a0)`, one argument per `?`.
type rustPred struct {
	Ident, Expr string
	Args        []string
}

type rustData struct {
	Name, Type, Table, PK, PKType string
	SchemaHash                    string
	Auto                          bool
	Cols                          []rustCol
	EqCols                        []rustCol // columns that support the default equality predicate (gets_by/get_count_by)
	UniqueFinders                 []rustFinder
	Numeric                       []rustCol
	Aggs                          []rustCol // count_distinct/min/max targets: unstyled or ip-styled, not json/bytes
	Preds                         []rustPred
	ParentCols                    []rustCol
	Rels                          []rustRel
	Links                         []goLink
	Indexes                       []string
	Fulltext                      [][]string
	UpdatedTs                     string
	Scope                         string
	KeyCols                       []string // PK/auto columns: never copied into on_duplicate
}

func opSnake(suffix string) string {
	var b strings.Builder
	for i, r := range suffix {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('_')
			}
			b.WriteRune(r + 32)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var rustTmpl = template.Must(template.New("rust").Funcs(template.FuncMap{
	"pascal": pascal, "ident": rustIdent, "opSnake": opSnake,
	"mapExpr": func(c rustCol) string {
		f := "self." + c.Ident
		switch {
		case c.RType == "serde_json::Value":
			return f + ".clone()"
		case c.RType == "chrono::NaiveDateTime" && c.Nullable:
			return f + ".map(|t| serde_json::json!(t.format(\"%Y-%m-%d %H:%M:%S%.6f\").to_string())).unwrap_or(serde_json::Value::Null)"
		case c.RType == "chrono::NaiveDateTime":
			return "serde_json::json!(" + f + ".format(\"%Y-%m-%d %H:%M:%S%.6f\").to_string())"
		case c.RType == "chrono::NaiveDate" && c.Nullable:
			return f + ".map(|d| serde_json::json!(d.to_string())).unwrap_or(serde_json::Value::Null)"
		case c.RType == "chrono::NaiveDate":
			return "serde_json::json!(" + f + ".to_string())"
		}
		return "serde_json::json!(" + f + ")"
	},
	"ftName": func(cols []string) string { return strings.Join(cols, "_with_") },
	"predParams": func(args []string) string {
		var b strings.Builder
		for _, a := range args {
			b.WriteString(", " + a + ": impl Into<Param>")
		}
		return b.String()
	},
	"predBinds": func(args []string) string {
		q := make([]string, len(args))
		for i, a := range args {
			q[i] = a + ".into()"
		}
		return "vec![" + strings.Join(q, ", ") + "]"
	},
	"finderParams": func(fields []rustCol) string {
		parts := make([]string, len(fields))
		for i, c := range fields {
			t := c.RType
			if c.IsStr {
				t = "impl Into<String>"
			}
			parts[i] = fmt.Sprintf("v%d: %s", i, t)
		}
		return strings.Join(parts, ", ")
	},
	"finderChain": func(fields []rustCol) string {
		var b strings.Builder
		for i, c := range fields {
			v := fmt.Sprintf("v%d", i)
			if c.IsStr {
				v += ".into()"
			}
			fmt.Fprintf(&b, "self.q.w().pred(%q, \"eq\", %s); ", c.Name, v)
		}
		return strings.TrimSpace(b.String())
	},
	"finderSnake": func(method string) string { return opSnake(method) },
	"rsList": func(cols []string) string {
		q := make([]string, len(cols))
		for i, c := range cols {
			q[i] = fmt.Sprintf("%q", c)
		}
		return strings.Join(q, ", ")
	},
}).Parse(`// Code generated by ormgen; DO NOT EDIT.
#![allow(clippy::all, dead_code, unused_imports, unused_mut)]

use orm::builder::{ColRef, Q, W};
use orm::binding::Binding;
use orm::db::{self, Exec};
use orm::value::{Param, Val};
use orm::{Collection, Key, Page, Result};

/// One row of {{.Table}}.
#[derive(Debug, Clone, Default)]
pub struct {{.Type}}Row {
    binding: Binding,
{{- range .Cols}}
    pub {{.Ident}}: {{if .Nullable}}Option<{{.RType}}>{{else}}{{.RType}}{{end}},
{{- end}}
{{- range .Rels}}
{{- if eq .Kind "one"}}
    {{.Ident}}_: Option<Box<super::{{.Target}}::{{.TargetType}}Row>>,
{{- else}}
    {{.Ident}}_: Collection<super::{{.Target}}::{{.TargetType}}Row>,
{{- end}}
{{- end}}
    assigned: Vec<&'static str>,
    original_version: Option<Param>,
    original_key: Option<Param>,
    dirty: Vec<(&'static str, Param)>,
    enc_err: Option<(String, String)>, // (code, msg) of the first codec error; surfaces from update
    extra: std::collections::HashMap<String, Val>, // select_expr / select_<col>_as outputs, by output name
    // the assembly this row was loaded through (shared with every row of the statement): projected
    // columns, drop_child_key ones, loaded relations, flattened one-relations, cascade children
    asm: Option<std::sync::Arc<orm::plan::Assemble>>,
}

impl {{.Type}}Row {
    /// Select a pool or transaction for this loaded row.
    pub fn using(&mut self, ex: &impl Exec) -> &mut Self { self.binding = Binding::new(ex); self }
    pub const ENTITY: &'static str = {{printf "%q" .Name}};
    pub const PK: &'static str = {{printf "%q" .PK}};

    /// Maps one row of the statement onto the struct: relation children first (rows of later
    /// steps, cloned per attachment; joins read the same row), then this node's columns,
    /// each cell decoded once straight from the source.
    pub(crate) fn from_row(src: &mut orm::Cells, a: &std::sync::Arc<orm::plan::Assemble>, rs: &db::Rows) -> Result<Self> {
        use orm::Src as _;
        let mut r = Self::default();
        r.asm = Some(a.clone());
        r.binding = rs.binding.clone();
        for ch in &a.children {
            match ch.rel.as_str() {
{{- range .Rels}}
                {{printf "%q" .Name}} => {
{{- if eq .Kind "one"}}
                    if let Some(ja) = &ch.assemble {
                        if db::join_present(src, ja) { r.{{.Ident}}_ = Some(Box::new(super::{{.Target}}::{{.TargetType}}Row::from_row(src, ja, rs)?)); }
                    } else if let Some(row) = rs.related(ch, src)?.first() {
                        let mut row = orm::Cells::Pos(row.to_vec());
                        r.{{.Ident}}_ = Some(Box::new(super::{{.Target}}::{{.TargetType}}Row::from_row(&mut row, rs.step_assemble(ch), rs)?));
                    }
{{- else}}
                    let related = rs.related(ch, src)?;
                    let mut c = Collection::with_capacity(related.len());
                    for row in related {
                        let mut row = orm::Cells::Pos(row.to_vec());
                        let k = Key::of(&row.val(ch.key_index)?);
                        c.put(k, super::{{.Target}}::{{.TargetType}}Row::from_row(&mut row, rs.step_assemble(ch), rs)?);
                    }
                    r.{{.Ident}}_ = c;
{{- end}}
                }
{{- end}}
                _ => {}
            }
        }
        for c in &a.columns {
            let i = c.index;
            match c.name.as_str() {
{{- range .Cols}}
{{- if .IsJson}}
                {{printf "%q" .Name}} => r.{{.Ident}} = src.json(i, &c.styles)?{{if not .Nullable}}.unwrap_or_default(){{end}},
{{- else}}
                {{printf "%q" .Name}} => r.{{.Ident}} = {{if .Nullable}}if src.is_null(i) { None } else { Some({{.Read}}) }{{else}}{{.Read}}{{end}},
{{- end}}
{{- end}}
                other => { let v = if c.styles.is_empty() { src.val(i)? } else { src.styled(i, &c.styles)? }; r.extra.insert(other.to_owned(), v); }
            }
        }
{{- if .UpdatedTs}}
        if r.has({{printf "%q" .UpdatedTs}}) { r.original_version = Some(r.{{ident .UpdatedTs}}.clone().into()); }
{{- end}}
        if r.has(Self::PK) { r.original_key = Some(r.{{ident .PK}}.clone().into()); }
        Ok(r)
    }
    /// A select_expr / select_<col>_as output by name.
    pub fn extra(&self, name: &str) -> Option<&Val> { self.extra.get(name) }

    /// The COUNT(*) value returned by a gets_count terminal.
    pub fn has(&self, name: &str) -> bool { self.assigned.contains(&name) || self.extra.contains_key(name) || self.asm.as_ref().is_some_and(|a| a.columns.iter().any(|c| c.name == name)) }
    pub fn rel_loaded(&self, name: &str) -> bool { self.asm.as_ref().is_some_and(|a| a.has_child(name)) }

    pub fn row_count(&self) -> i64 { self.extra("row_count").map(|v| v.as_i64()).unwrap_or(0) }

    /// The row's array form (what PHP's toArray() and Go's ToArray() give): projected
    /// columns minus drop_child_key ones, extra outputs, loaded relations, and flattened
    /// one-relations merged in (this row's keys win).
    pub fn to_map(&self) -> Result<serde_json::Value> {
        let mut m = serde_json::Map::new();
        let empty = orm::plan::Assemble::default();
        let a = self.asm.as_deref().unwrap_or(&empty);
        let names = a.columns.iter().map(|c| c.name.as_str()).chain(self.assigned.iter().copied());
        for name in names {
            if a.columns.iter().any(|c| c.name == name && c.hidden) { continue; }
            let v = match name {
{{- range .Cols}}
                {{printf "%q" .Name}} => {{mapExpr .}},
{{- end}}
                other => self.extra.get(other).map(|v| v.to_json()).unwrap_or(serde_json::Value::Null),
            };
            m.insert(name.to_owned(), v);
        }
{{- range .Rels}}
        if a.has_child({{printf "%q" .Name}}) {
{{- if eq .Kind "one"}}
            m.insert({{printf "%q" .Name}}.into(), match &self.{{.Ident}}_ { Some(c) => c.to_map()?, None => serde_json::Value::Null });
{{- else}}
            m.insert({{printf "%q" .Name}}.into(), self.{{.Ident}}_.to_map()?);
{{- end}}
        }
{{- end}}
        for ch in a.children.iter().filter(|ch| ch.flatten) {
            if let Some(serde_json::Value::Object(child)) = m.get(&ch.rel).cloned() {
                for (k, v) in child { m.entry(k).or_insert(v); }
            }
        }
        Ok(serde_json::Value::Object(m))
    }
{{range .Rels}}
{{- if eq .Kind "one"}}
    pub fn {{.Ident}}(&self) -> Option<&super::{{.Target}}::{{.TargetType}}Row> { self.{{.Ident}}_.as_deref() }
    pub fn {{.Ident}}_mut(&mut self) -> Option<&mut super::{{.Target}}::{{.TargetType}}Row> { self.{{.Ident}}_.as_deref_mut() }
{{- else}}
    pub fn {{.Ident}}(&self) -> &Collection<super::{{.Target}}::{{.TargetType}}Row> { &self.{{.Ident}}_ }
    pub fn {{.Ident}}_mut(&mut self) -> &mut Collection<super::{{.Target}}::{{.TargetType}}Row> { &mut self.{{.Ident}}_ }
{{- end}}
{{- end}}
{{range .Cols}}{{if not .Auto}}
    pub fn set_{{.Ident}}(&mut self, v: {{if .Nullable}}Option<{{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}>{{else}}{{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}{{end}}) -> &mut Self {
        let v: {{if .Nullable}}Option<{{.RType}}>{{else}}{{.RType}}{{end}} = {{if .Nullable}}v.map(|x| x.into()){{else}}v.into(){{end}};
        self.{{.Ident}} = v.clone();
        if !self.assigned.contains(&{{printf "%q" .Name}}) { self.assigned.push({{printf "%q" .Name}}); }
{{- if .Styles}}
        match orm::codec::encode(&[{{rsList .Styles}}], {{if .Nullable}}v.as_ref(){{else}}Some(&v){{end}}) {
            Ok(p) => self.mark_dirty({{printf "%q" .Name}}, p),
            Err(e) => { if self.enc_err.is_none() { self.enc_err = Some((e.code().to_string(), e.to_string())); } }
        }
{{- else}}
        self.mark_dirty({{printf "%q" .Name}}, v.into());
{{- end}}
        self
    }
{{- end}}{{end}}

    fn mark_dirty(&mut self, col: &'static str, value: Param) {
        if let Some((_, v)) = self.dirty.iter_mut().find(|(c, _)| *c == col) { *v = value; }
        else { self.dirty.push((col, value)); }
    }

    /// UPDATE the columns changed through set_*.
    pub async fn update(&mut self) -> Result<()> { let binding = self.binding.clone(); self.update_inner(binding.resolve()?, false).await }
{{- if .UpdatedTs}}

    /// UPDATE with optimistic locking on {{.UpdatedTs}}; fails with OptimisticLock when the row changed.
    pub async fn update_optimistic(&mut self) -> Result<()> { let binding = self.binding.clone(); self.update_inner(binding.resolve()?, true).await }
{{- end}}

    async fn update_inner(&mut self, ex: &impl Exec, optimistic: bool) -> Result<()> {
        if let Some((code, msg)) = &self.enc_err { return Err(orm::Error::Engine { code: code.clone(), msg: msg.clone() }); }
        if self.original_key.is_none() { return Err(orm::Error::Config("update on a row that was not loaded".into())); }
        if optimistic && self.original_version.is_none() { return Err(orm::Error::Config("optimistic update requires a loaded version column".into())); }
        if self.dirty.is_empty() { return Ok(()); }
        let mut q = Q::new(super::schema_hash(), Self::ENTITY);
        for (c, v) in &self.dirty { q.set(c, v.clone()); }
        let pk = self.original_key.clone().ok_or_else(|| orm::Error::Config("row has no loaded identity".into()))?;
        q.w().pred(Self::PK, "eq", pk);
{{- if .UpdatedTs}}
        if optimistic {
            let p = q.req.p(self.original_version.as_ref().unwrap().clone());
            q.req.ir.optimistic = Some(orm::ir::Optimist { column: {{printf "%q" .UpdatedTs}}.into(), p });
        }
{{- else}}
        let _ = optimistic;
{{- end}}
        db::write(ex, &mut q.req, "update").await?;
        self.dirty.clear();
        Ok(())
    }

    pub async fn delete(&self) -> Result<()> { self.delete_inner(self.binding.resolve()?).await }

    async fn delete_inner(&self, ex: &impl Exec) -> Result<()> {
        if self.asm.is_none() { return Err(orm::Error::Config("delete on a row that was not loaded".into())); }
        let mut q = Q::new(super::schema_hash(), Self::ENTITY);
        let pk = self.original_key.clone().ok_or_else(|| orm::Error::Config("row has no loaded identity".into()))?;
        q.w().pred(Self::PK, "eq", pk);
        db::write(ex, &mut q.req, "delete").await.map(|_| ())
    }

    /// Depth-first: deletes the rows of every loaded relation that belongs to this row
    /// (children[].cascade: the related rows hold this row's PK as their FK and
    /// no_cascade_delete was not set), each through its own delete_cascade in collection
    /// order, then this row. Parent-direction relations (the FK is on this row) are never deleted.
    /// One DELETE … WHERE pk = ? per row. On a Db the whole walk runs in one transaction.
    pub async fn delete_cascade(&self) -> Result<()> {
        let ex = self.binding.resolve()?;
        if self.asm.is_none() { return Err(orm::Error::Config("delete_cascade on a row that was not loaded".into())); }
        match ex.tx() {
            Some(tx) => self.delete_cascade_in(tx).await,
            None => ex.db().transaction(|tx| async move { self.delete_cascade_in(&tx).await }).await,
        }
    }

    /// The walk itself. Boxed: rows cascade into rows of other entities, which cascade back.
    pub fn delete_cascade_in<'a>(&'a self, tx: &'a db::Tx) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let Some(a) = &self.asm else { return Ok(()) };
            for ch in a.children.iter().filter(|ch| ch.cascade) {
                match ch.rel.as_str() {
{{- range .Rels}}
                    {{printf "%q" .Name}} => {
{{- if eq .Kind "one"}}
                        if let Some(r) = self.{{.Ident}}_.as_deref() { r.delete_cascade_in(tx).await?; }
{{- else}}
                        for (_, r) in self.{{.Ident}}_.iter() { r.delete_cascade_in(tx).await?; }
{{- end}}
                    }
{{- end}}
                    _ => {}
                }
            }
            self.delete_inner(tx).await
        })
    }
}

impl orm::collection::RowExport for {{.Type}}Row {
    fn to_map(&self) -> Result<serde_json::Value> { {{.Type}}Row::to_map(self) }
}

/// Column references for column-to-column predicates (w.seq_eq_col(cols::seq())); .at("service") points into a joined entity.
pub mod cols {
    use orm::builder::ColRef;
{{- range .Cols}}
    pub fn {{.Ident}}() -> ColRef { ColRef::new({{printf "%q" .Name}}) }
{{- end}}
}

/// Where builder for {{.Table}}: predicates, or(), and(|w| …), relation navigation.
pub struct {{.Type}}Where<'a> { pub(crate) w: W<'a> }

impl<'a> {{.Type}}Where<'a> {
    pub fn or(mut self) -> Self { self.w.or(); self }
    pub fn and(mut self, f: impl FnOnce({{.Type}}Where<'_>) -> {{.Type}}Where<'_>) -> Self { self.w.and_with(|w| { f({{.Type}}Where { w }); }); self }
	pub fn expr(mut self, frag: &str, binds: Vec<Param>) -> Self { self.w.expr(frag, binds); self }
{{- if .Scope}}
    pub fn scope(mut self, v: impl Into<Param>) -> Self { self.w.pred({{printf "%q" .Scope}}, "eq", v.into()); self }
{{- end}}
{{- range .Preds}}
    pub fn {{.Ident}}(mut self{{predParams .Args}}) -> Self { self.w.expr({{printf "%q" .Expr}}, {{predBinds .Args}}); self }
{{- end}}
{{- range .Rels}}
    pub fn {{.Ident}}(mut self, f: impl FnOnce(super::{{.Target}}::{{.TargetType}}Where<'_>) -> super::{{.Target}}::{{.TargetType}}Where<'_>) -> Self { self.w.nav_with({{printf "%q" .Name}}, |w| { f(super::{{.Target}}::{{.TargetType}}Where { w }); }); self }
{{- end}}
{{range .Cols}}{{$c := .}}{{range .Ops}}
{{- if eq .Kind "one"}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, v: {{if $c.IsStr}}impl Into<String>{{else}}{{$c.RType}}{{end}}) -> Self { self.w.pred({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, {{if $c.IsStr}}v.into(){{else}}v{{end}}); self }
{{- if eq .Op "eq"}}
    pub fn {{$c.Ident}}(self, v: {{if $c.IsStr}}impl Into<String>{{else}}{{$c.RType}}{{end}}) -> Self { self.{{$c.Ident}}_eq(v) }
{{- end}}
{{- else if eq .Kind "list"}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, vs: Vec<{{$c.RType}}>) -> Self { self.w.pred_list({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, vs.into_iter().map(Into::into).collect()); self }
{{- else if eq .Kind "pair"}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, lo: {{$c.RType}}, hi: {{$c.RType}}) -> Self { self.w.pred_list({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, vec![lo.into(), hi.into()]); self }
{{- else}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self) -> Self { self.w.pred_null({{printf "%q" $c.Name}}, {{printf "%q" .Op}}); self }
{{- end}}
{{- end}}
{{- range $c.ColOps}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, r: ColRef) -> Self { self.w.pred_col({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, r); self }
{{- end}}{{end}}
{{- range .Fulltext}}
    pub fn {{ftName .}}_match(mut self, v: &str) -> Self { self.w.match_(&[{{rsList .}}], false, v); self }
    pub fn {{ftName .}}_match_boolean(mut self, v: &str) -> Self { self.w.match_(&[{{rsList .}}], true, v); self }
{{- end}}
}

/// Query over {{.Table}}: query() → using(&db) → chain → terminal().await.
pub struct {{.Type}} {
    binding: Binding,
    pub q: Q,
    key_fn: Option<Box<dyn Fn(&{{.Type}}Row) -> Key + Send + Sync>>,
}

/// Construct a query over {{.Table}}.
pub fn query() -> {{.Type}} {
    {{.Type}} { binding: Binding::default(), q: Q::new(super::schema_hash(), {{printf "%q" .Name}}), key_fn: None }
}

impl {{.Type}} {
    /// Select a pool or transaction for this query.
    pub fn using(mut self, ex: &impl Exec) -> Self { self.binding = Binding::new(ex); self }

    /// Keys the root collection by a function of each row (relations key by key_by_<col>).
    pub fn key_by_fn(mut self, f: impl Fn(&{{.Type}}Row) -> Key + Send + Sync + 'static) -> Self { self.key_fn = Some(Box::new(f)); self }

    // ---- WHERE ----
    pub fn or(mut self) -> Self { self.q.or(); self }
    pub fn and(mut self, f: impl FnOnce({{.Type}}Where<'_>) -> {{.Type}}Where<'_>) -> Self { self.q.w().and_with(|w| { f({{.Type}}Where { w }); }); self }
    pub fn expr(mut self, frag: &str, binds: Vec<Param>) -> Self { self.q.w().expr(frag, binds); self }
{{- if .Scope}}
    pub fn scope(mut self, v: impl Into<Param>) -> Self { self.q.w().pred({{printf "%q" .Scope}}, "eq", v.into()); self }
{{- end}}
{{- range .Preds}}
    pub fn {{.Ident}}(mut self{{predParams .Args}}) -> Self { self.q.w().expr({{printf "%q" .Expr}}, {{predBinds .Args}}); self }
{{- end}}
{{- range .Rels}}
    pub fn {{.Ident}}(mut self, f: impl FnOnce(super::{{.Target}}::{{.TargetType}}Where<'_>) -> super::{{.Target}}::{{.TargetType}}Where<'_>) -> Self { self.q.w().nav_with({{printf "%q" .Name}}, |w| { f(super::{{.Target}}::{{.TargetType}}Where { w }); }); self }
{{- end}}
{{range .Cols}}{{$c := .}}{{range .Ops}}
{{- if eq .Kind "one"}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, v: {{if $c.IsStr}}impl Into<String>{{else}}{{$c.RType}}{{end}}) -> Self { self.q.w().pred({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, {{if $c.IsStr}}v.into(){{else}}v{{end}}); self }
{{- if eq .Op "eq"}}
    pub fn {{$c.Ident}}(self, v: {{if $c.IsStr}}impl Into<String>{{else}}{{$c.RType}}{{end}}) -> Self { self.{{$c.Ident}}_eq(v) }
{{- end}}
{{- else if eq .Kind "list"}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, vs: Vec<{{$c.RType}}>) -> Self { self.q.w().pred_list({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, vs.into_iter().map(Into::into).collect()); self }
{{- else if eq .Kind "pair"}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, lo: {{$c.RType}}, hi: {{$c.RType}}) -> Self { self.q.w().pred_list({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, vec![lo.into(), hi.into()]); self }
{{- else}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self) -> Self { self.q.w().pred_null({{printf "%q" $c.Name}}, {{printf "%q" .Op}}); self }
{{- end}}
{{- end}}
{{- range $c.ColOps}}
    pub fn {{$c.Ident}}_{{opSnake .Suffix}}(mut self, r: ColRef) -> Self { self.q.w().pred_col({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, r); self }
{{- end}}{{end}}
{{- range .Fulltext}}
    pub fn {{ftName .}}_match(mut self, v: &str) -> Self { self.q.w().match_(&[{{rsList .}}], false, v); self }
    pub fn {{ftName .}}_match_boolean(mut self, v: &str) -> Self { self.q.w().match_(&[{{rsList .}}], true, v); self }
{{- end}}

    // ---- join children: on() = ON, where_() = parent WHERE group ----
    pub fn on(mut self, f: impl FnOnce({{.Type}}Where<'_>) -> {{.Type}}Where<'_>) -> Self { { let w = self.q.on_w(); f({{.Type}}Where { w }); } self }
    pub fn where_(mut self, f: impl FnOnce({{.Type}}Where<'_>) -> {{.Type}}Where<'_>) -> Self { { let w = self.q.w(); f({{.Type}}Where { w }); } self }
    pub fn relation(mut self, child: impl AsRef<Q>) -> Self {
        let c = child.as_ref();
        match (c.entity(), c.link_left.as_str(), c.link_right.as_str()) {
{{- range .Rels}}{{- if eq .Kind "one"}}
            ({{printf "%q" .Target}}, {{printf "%q" .Left}}, {{printf "%q" .Right}}) => { self.q.relation({{printf "%q" .Name}}, c); self },
{{- if .Default}}
            ({{printf "%q" .Target}}, "", "") => { self.q.relation({{printf "%q" .Name}}, c); self },
{{- end}}
{{- end}}{{- end}}
            _ => panic!("no one-to-one relation from {{.Name}}"),
        }
    }
    pub fn relations(mut self, child: impl AsRef<Q>) -> Self {
        let c = child.as_ref();
        match (c.entity(), c.link_left.as_str(), c.link_right.as_str()) {
{{- range .Rels}}{{- if eq .Kind "many"}}
            ({{printf "%q" .Target}}, {{printf "%q" .Left}}, {{printf "%q" .Right}}) => { self.q.relation({{printf "%q" .Name}}, c); self },
{{- if .Default}}
            ({{printf "%q" .Target}}, "", "") => { self.q.relation({{printf "%q" .Name}}, c); self },
{{- end}}
{{- end}}{{- end}}
            _ => panic!("no one-to-many relation from {{.Name}}"),
        }
    }
    pub fn join(mut self, child: impl AsRef<Q>) -> Self { self.join_target(child, "inner") }
    pub fn left_join(mut self, child: impl AsRef<Q>) -> Self { self.join_target(child, "left") }
    fn join_target(mut self, child: impl AsRef<Q>, kind: &str) -> Self {
        let c = child.as_ref();
        match (c.entity(), c.link_left.as_str(), c.link_right.as_str()) {
{{- range .Rels}}
            ({{printf "%q" .Target}}, {{printf "%q" .Left}}, {{printf "%q" .Right}}) => { self.q.join({{printf "%q" .Name}}, kind, c); self },
{{- if .Default}}
            ({{printf "%q" .Target}}, "", "") => { self.q.join({{printf "%q" .Name}}, kind, c); self },
{{- end}}
{{- end}}
            _ => panic!("no relation from {{.Name}}"),
        }
    }
{{range .Rels}}
{{if .Pair}}
    pub fn join_{{ident .Left}}_with_{{ident .Right}}(mut self, child: impl AsRef<super::{{.Target}}::{{.TargetType}}>) -> Self { self.q.join("{{.Name}}", "inner", &child.as_ref().q); self }
    pub fn left_join_{{ident .Left}}_with_{{ident .Right}}(mut self, child: impl AsRef<super::{{.Target}}::{{.TargetType}}>) -> Self { self.q.join("{{.Name}}", "left", &child.as_ref().q); self }
{{- if eq .Kind "one"}}
    pub fn relation_{{ident .Left}}_with_{{ident .Right}}(mut self, child: impl AsRef<super::{{.Target}}::{{.TargetType}}>) -> Self { self.q.relation("{{.Name}}", &child.as_ref().q); self }
{{- else}}
    pub fn relations_{{ident .Left}}_with_{{ident .Right}}(mut self, child: impl AsRef<super::{{.Target}}::{{.TargetType}}>) -> Self { self.q.relation("{{.Name}}", &child.as_ref().q); self }
{{- end}}
{{- end}}
{{- end}}
{{range .Links}}
    pub fn {{opSnake .Match}}(mut self) -> Self { self.q.set_link({{printf "%q" .Left}}, {{printf "%q" .Right}}); self }
    pub fn {{opSnake .On}}(mut self) -> Self { self.q.set_link({{printf "%q" .Left}}, {{printf "%q" .Right}}); self }
{{- end}}

    // ---- columns ----
    pub fn select_all(mut self) -> Self { self.q.columns().mode = "all".into(); self }
    pub fn select_none(mut self) -> Self { self.q.columns().mode = "none".into(); self }
    pub fn select_expr(mut self, name: &str, frag: &str) -> Self { self.q.columns().expr.insert(name.into(), frag.into()); self }
{{- range .Cols}}
    pub fn select_{{.Ident}}(mut self) -> Self { self.q.columns().add.push({{printf "%q" .Name}}.into()); self }
    pub fn unselect_{{.Ident}}(mut self) -> Self { self.q.columns().remove.push({{printf "%q" .Name}}.into()); self }
    pub fn select_{{.Ident}}_as(mut self, name: &str) -> Self { self.q.columns().as_.insert(name.into(), {{printf "%q" .Name}}.into()); self }
{{- end}}

    // ---- order, group, limit ----
{{- range .Cols}}
    pub fn order_by_{{.Ident}}_asc(mut self) -> Self { self.q.order({{printf "%q" .Name}}, false); self }
    pub fn order_by_{{.Ident}}_desc(mut self) -> Self { self.q.order({{printf "%q" .Name}}, true); self }
    pub fn group_by_{{.Ident}}(mut self) -> Self { self.q.node().group_by.push({{printf "%q" .Name}}.into()); self }
    pub fn key_by_{{.Ident}}(mut self) -> Self { self.q.node().key_by = {{printf "%q" .Name}}.into(); self }
{{- end}}
    pub fn order_by_expr(mut self, frag: &str, desc: bool) -> Self { self.q.order_expr(frag, desc); self }
    pub fn group_by_expr(mut self, expr: &str, as_: &str) -> Self { self.q.group_by_expr(expr, as_); self }
    pub fn limit(mut self, offset: u32, count: u32) -> Self { self.q.node().limit = Some(orm::ir::Limit { offset, count }); self }
    pub fn distinct(mut self) -> Self { self.q.node().distinct = true; self }
    /// Group predicates after group_by_<col>(); the closure gets the same Where builder (aggregates via expr("COUNT(*) > ?", …)).
    pub fn having(mut self, f: impl FnOnce({{.Type}}Where<'_>) -> {{.Type}}Where<'_>) -> Self { { let w = self.q.having_w(); f({{.Type}}Where { w }); } self }
{{- range .Indexes}}
    pub fn force_index_{{.}}(mut self) -> Self { self.q.node().force_index = {{printf "%q" .}}.into(); self }
{{- end}}

    // ---- raw root (trusted code only): {table} = the entity table, ? = binds in order; run with raw_all ----
    pub fn raw(mut self, sql: &str, binds: Vec<Param>) -> Self { self.q.raw(sql, binds); self }

    // ---- relation-child options ----
    pub fn flatten(mut self) -> Self { self.q.node().flatten = true; self }
    pub fn limit_per_parent(mut self, n: u32) -> Self { self.q.node().limit_per_parent = n; self }
    pub fn drop_child_key(mut self) -> Self { self.q.node().drop_child_key = true; self }
    pub fn no_cascade_delete(mut self) -> Self { self.q.node().no_cascade_delete = true; self }
{{- range .ParentCols}}{{if eq .ColType "i32" "i64" "bool" "string" "enum"}}
    pub fn if_parent_{{.Ident}}_eq(mut self, v: {{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}) -> Self { self.q.if_parent({{printf "%q" .Name}}, {{if .IsStr}}v.into(){{else}}v{{end}}); self }
{{- end}}{{end}}

    // ---- insert/update draft (set_<pk> only decides save: INSERT rejects it, UPDATE cannot change it) ----
{{- range .Cols}}{{if or (not .Auto) .PK}}
    pub fn set_{{.Ident}}(mut self, v: {{if .Nullable}}Option<{{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}>{{else}}{{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}{{end}}) -> Self { let v: {{if .Nullable}}Option<{{.RType}}>{{else}}{{.RType}}{{end}} = {{if .Nullable}}v.map(|x| x.into()){{else}}v.into(){{end}}; {{if .Styles}}match orm::codec::encode(&[{{rsList .Styles}}], {{if .Nullable}}v.as_ref(){{else}}Some(&v){{end}}) { Ok(p) => self.q.set({{printf "%q" .Name}}, p), Err(e) => self.q.defer_err(e) }{{else}}self.q.set({{printf "%q" .Name}}, v){{end}}; self }
{{- end}}{{if not .Auto}}
    pub fn set_{{.Ident}}_expr(mut self, frag: &str, binds: Vec<Param>) -> Self { self.q.set_expr({{printf "%q" .Name}}, frag, binds); self }
{{- end}}{{end}}
{{- range .Numeric}}
    pub fn plus_{{.Ident}}(mut self, v: {{.RType}}) -> Self { self.q.plus({{printf "%q" .Name}}, v); self }
    pub fn minus_{{.Ident}}(mut self, v: {{.RType}}) -> Self { self.q.minus({{printf "%q" .Name}}, v); self }
{{- end}}

    // ---- insert: ON DUPLICATE KEY UPDATE assignments (never the PK/auto column) ----
{{- range .Cols}}{{if not (or .Auto .PK)}}
    pub fn on_duplicate_set_{{.Ident}}(mut self, v: {{if .Nullable}}Option<{{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}>{{else}}{{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}{{end}}) -> Self { let v: {{if .Nullable}}Option<{{.RType}}>{{else}}{{.RType}}{{end}} = {{if .Nullable}}v.map(|x| x.into()){{else}}v.into(){{end}}; {{if .Styles}}match orm::codec::encode(&[{{rsList .Styles}}], {{if .Nullable}}v.as_ref(){{else}}Some(&v){{end}}) { Ok(p) => self.q.on_duplicate_set({{printf "%q" .Name}}, p), Err(e) => self.q.defer_err(e) }{{else}}self.q.on_duplicate_set({{printf "%q" .Name}}, v){{end}}; self }
    pub fn on_duplicate_set_{{.Ident}}_expr(mut self, frag: &str, binds: Vec<Param>) -> Self { self.q.on_duplicate_set_expr({{printf "%q" .Name}}, frag, binds); self }
{{- end}}{{end}}
{{- range .Numeric}}{{if not (or .Auto .PK)}}
    pub fn on_duplicate_plus_{{.Ident}}(mut self, v: {{.RType}}) -> Self { self.q.on_duplicate_plus({{printf "%q" .Name}}, v); self }
    pub fn on_duplicate_minus_{{.Ident}}(mut self, v: {{.RType}}) -> Self { self.q.on_duplicate_minus({{printf "%q" .Name}}, v); self }
{{- end}}{{end}}
    /// Copies every set_* assignment made so far (except the PK/auto column) into ON DUPLICATE KEY UPDATE.
    pub fn on_duplicate_set_all(mut self) -> Self { self.q.on_duplicate_set_all(&[{{rsList .KeyCols}}]); self }

    // ---- terminals ----
    pub async fn one(&mut self) -> Result<Option<{{.Type}}Row>> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        let mut rows = db::select(ex, &mut self.q.req, "one").await?;
        Ok(match rows.take_cells().into_iter().next() {
            Some(mut src) => Some({{.Type}}Row::from_row(&mut src, &rows.assemble, &rows)?),
            None => None,
        })
    }

    pub async fn all(&mut self) -> Result<Collection<{{.Type}}Row>> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        let mut rows = db::select(ex, &mut self.q.req, "all").await?;
        collect(&mut rows, self.key_fn.as_deref())
    }

    /// Preferred single-row terminal; one() remains available for compatibility.
    pub async fn get(&mut self) -> Result<Option<{{.Type}}Row>> {
        self.one().await
    }

    /// Preferred collection terminal; all() remains available for compatibility.
    pub async fn gets(&mut self) -> Result<Collection<{{.Type}}Row>> {
        self.all().await
    }

{{range .EqCols}}
    /// Applies {{.Name}} = value and runs the collection terminal.
    pub async fn gets_by_{{.Ident}}(&mut self, v: {{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}) -> Result<Collection<{{$.Type}}Row>> {
        self.q.w().pred({{printf "%q" .Name}}, "eq", {{if .IsStr}}v.into(){{else}}v{{end}});
        self.gets().await
    }
{{end}}
    pub async fn count(&mut self) -> Result<i64> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        Ok(db::scalar(ex, &mut self.q.req, "count").await?.as_i64())
    }

    /// Preferred scalar count terminal; count() remains available as a compatibility alias.
    pub async fn get_count(&mut self) -> Result<i64> {
        self.count().await
    }

{{range .EqCols}}
    /// Applies {{.Name}} = value and runs the scalar count terminal.
    pub async fn get_count_by_{{.Ident}}(&mut self, v: {{if .IsStr}}impl Into<String>{{else}}{{.RType}}{{end}}) -> Result<i64> {
        self.q.w().pred({{printf "%q" .Name}}, "eq", {{if .IsStr}}v.into(){{else}}v{{end}});
        self.get_count().await
    }
{{end}}
    /// Returns one row per group_by value; the aggregate is available as extra("row_count").
    pub async fn gets_count(&mut self) -> Result<Collection<{{.Type}}Row>> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        let mut rows = db::select(ex, &mut self.q.req, "group_count").await?;
        collect(&mut rows, self.key_fn.as_deref())
    }
{{- range .Numeric}}
    pub async fn sum_{{.Ident}}(&mut self) -> Result<f64> { let binding = self.binding.clone(); let ex = binding.resolve()?; self.q.req.ir.agg = {{printf "%q" .Name}}.into(); Ok(db::scalar(ex, &mut self.q.req, "sum").await?.as_f64()) }
    pub async fn avg_{{.Ident}}(&mut self) -> Result<f64> { let binding = self.binding.clone(); let ex = binding.resolve()?; self.q.req.ir.agg = {{printf "%q" .Name}}.into(); Ok(db::scalar(ex, &mut self.q.req, "avg").await?.as_f64()) }
{{- end}}
{{- range .Aggs}}
    pub async fn count_distinct_{{.Ident}}(&mut self) -> Result<i64> { let binding = self.binding.clone(); let ex = binding.resolve()?; self.q.req.ir.agg = {{printf "%q" .Name}}.into(); Ok(db::scalar(ex, &mut self.q.req, "count_distinct").await?.as_i64()) }
    /// None when no row matches.
    pub async fn min_{{.Ident}}(&mut self) -> Result<Option<{{.RType}}>> { let binding = self.binding.clone(); let ex = binding.resolve()?; self.q.req.ir.agg = {{printf "%q" .Name}}.into(); let mut v = db::scalar(ex, &mut self.q.req, "min").await?; let v = &mut v; Ok(if v.is_null() { None } else { Some({{.From}}) }) }
    /// None when no row matches.
    pub async fn max_{{.Ident}}(&mut self) -> Result<Option<{{.RType}}>> { let binding = self.binding.clone(); let ex = binding.resolve()?; self.q.req.ir.agg = {{printf "%q" .Name}}.into(); let mut v = db::scalar(ex, &mut self.q.req, "max").await?; let v = &mut v; Ok(if v.is_null() { None } else { Some({{.From}}) }) }
{{- end}}

    /// Runs the raw() statement; rows keyed by the driver's column names in column order, cells typed by column type (no codec).
    pub async fn raw_all(&mut self) -> Result<Vec<indexmap::IndexMap<String, Val>>> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        db::raw(ex, &mut self.q.req).await
    }

    pub async fn paginate(&mut self, page: u32, per: u32) -> Result<Page<{{.Type}}Row>> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        if per == 0 { return Err(orm::Error::Engine { code: orm::codes::IR_INVALID.into(), msg: "per must be positive".into() }); }
        let page = page.max(1);
        self.q.node().limit = Some(orm::ir::Limit { offset: (page - 1) * per, count: per });
        let (mut rows, total) = db::paginate(ex, &mut self.q.req).await?;
        let pages = (total + per as i64 - 1) / per as i64;
        Ok(Page { items: collect(&mut rows, self.key_fn.as_deref())?, total, pages, current: page as i64, per: per as i64 })
    }

    pub async fn insert(&mut self) -> Result<Option<{{.Type}}Row>> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        let (id, _) = db::write(ex, &mut self.q.req, "insert").await?;
{{- if .Auto}}
        super::{{.Name}}::query().using(ex).{{ident .PK}}_eq(id as {{.PKType}}).one().await
{{- else}}
        let _ = id;
        Ok(None)
{{- end}}
    }

    /// With set_{{ident .PK}}: UPDATE the other set columns WHERE {{.PK}} = that value and re-read the row; otherwise INSERT.
    pub async fn save(&mut self) -> Result<Option<{{.Type}}Row>> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        match self.q.take_set({{printf "%q" .PK}}) {
            Some(pk) => {
                self.q.w().pred({{printf "%q" .PK}}, "eq", pk.clone());
                db::write(ex, &mut self.q.req, "update").await?;
                let mut q = super::{{.Name}}::query().using(ex);
                q.q.w().pred({{printf "%q" .PK}}, "eq", pk);
                q.one().await
            }
            None => self.insert().await,
        }
    }

    /// UPDATE set_*/plus_*/minus_*/set_*_expr WHERE the query's predicates; returns the affected count.
    /// The engine rejects a missing where (IR_INVALID).
    pub async fn update(&mut self) -> Result<u64> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        Ok(db::write(ex, &mut self.q.req, "update").await?.1)
    }

    /// DELETE WHERE the query's predicates; returns the affected count. The engine rejects a missing where.
    pub async fn delete(&mut self) -> Result<u64> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        Ok(db::write(ex, &mut self.q.req, "delete").await?.1)
    }

    /// The main statement (kind all) and its binds without executing; secret slots read "$SECRET".
    pub async fn sql(&mut self) -> Result<db::Sql> { let binding = self.binding.clone(); let ex = binding.resolve()?;
        db::sql(ex, &mut self.q.req, "all")
    }

    pub async fn one_by_{{ident .PK}}(&mut self, v: {{.PKType}}) -> Result<Option<{{.Type}}Row>> {
        self.q.w().pred({{printf "%q" .PK}}, "eq", v);
        self.one().await
    }

    /// Preferred primary-key lookup; one_by_{{ident .PK}} remains available for compatibility.
    pub async fn get_by_{{ident .PK}}(&mut self, v: {{.PKType}}) -> Result<Option<{{.Type}}Row>> {
        self.one_by_{{ident .PK}}(v).await
    }
{{range .UniqueFinders}}
    /// Applies the equality predicates for the declared unique key and runs the single-row terminal.
    pub async fn get_by_{{finderSnake .Method}}(&mut self, {{finderParams .Fields}}) -> Result<Option<{{$.Type}}Row>> {
        {{finderChain .Fields}}
        self.get().await
    }
{{end}}
}

impl AsRef<{{.Type}}> for {{.Type}} { fn as_ref(&self) -> &Self { self } }
impl AsRef<Q> for {{.Type}} { fn as_ref(&self) -> &Q { &self.q } }

impl Default for {{.Type}} { fn default() -> Self { query() } }

fn collect(rows: &mut db::Rows, key_fn: Option<&(dyn Fn(&{{.Type}}Row) -> Key + Send + Sync)>) -> Result<Collection<{{.Type}}Row>> {
    use orm::Src as _;
    let cells = rows.take_cells();
    let mut c = Collection::with_capacity(cells.len());
    for mut src in cells {
        let k = Key::of(&src.val(0)?);
        let r = {{.Type}}Row::from_row(&mut src, &rows.assemble, rows)?;
        let k = match key_fn { Some(f) => f(&r), None => k };
        c.put(k, r);
    }
    Ok(c)
}
`))

const rustLib = `// Code generated by ormgen; DO NOT EDIT.
//! Generated entities. Call init() once with the engine, then use \x60battle::query()\x60 etc.
#![allow(clippy::all)]

use std::sync::{Arc, OnceLock};

pub mod interfaces;

/// The manifest hash this crate was generated from (schema.json \x60schema_hash\x60).
pub const SCHEMA_HASH: &str = %q;

static ENGINE: OnceLock<Arc<orm::Engine>> = OnceLock::new();

/// Bind the generated crate to a compiled engine (once per process). The engine's loaded
/// manifest must be the one this crate was generated from: a different hash is
/// SCHEMA_HASH_MISMATCH and the crate stays unbound (no watching, no reload).
pub fn init(engine: Arc<orm::Engine>) -> orm::Result<()> {
    if engine.schema_hash != SCHEMA_HASH {
        return Err(orm::Error::Engine {
            code: orm::codes::SCHEMA_HASH_MISMATCH.into(),
            msg: format!("generated from {} but the engine loaded {}", SCHEMA_HASH, engine.schema_hash),
        });
    }
    let _ = ENGINE.set(engine);
    Ok(())
}

pub fn engine() -> Arc<orm::Engine> {
    ENGINE.get().expect("gen::init(engine) must be called first").clone()
}

/// The manifest hash this crate was generated from (the untyped Q::new needs it).
pub fn schema_hash() -> &'static str {
    SCHEMA_HASH
}
`

const rustCargo = `[package]
name = "gen"
version = "0.0.1"
edition = "2021"
publish = false
description = "Generated entities for the orm engine (ormgen gen --lang rust)"
license = "MIT"

[dependencies]
orm = { path = "../orm" }
chrono = { version = "0.4", default-features = false, features = ["std"] }
serde_json = "1"
indexmap = "2"
`

func genRust(m *schema.Manifest, outDir string) error {
	src := filepath.Join(outDir, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		return err
	}
	var lib bytes.Buffer
	lib.WriteString(fmt.Sprintf(strings.ReplaceAll(rustLib, `\x60`, "`"), m.SchemaHash))
	for _, name := range m.Order {
		e := m.Entities[name]
		ge := buildGoEntity(m, e)
		d := rustData{Name: ge.Name, Type: ge.Type, Table: ge.Table, PK: ge.PK, Auto: ge.Auto, Indexes: ge.Indexes, Fulltext: ge.Fulltext, UpdatedTs: ge.UpdatedTs, SchemaHash: m.SchemaHash, Links: ge.Links, Scope: ge.Scope}
		for _, c := range ge.Cols {
			col := e.Column(c.Name)
			rc := rustCol{goCol: c, RType: rustType(col), Ident: rustIdent(c.Name)}
			rc.From = rustFrom(rc.RType)
			rc.Read = rustRead(rc.RType)
			rc.IsStr = rc.RType == "String"
			rc.IsJson = rc.RType == "serde_json::Value"
			d.Cols = append(d.Cols, rc)
			if allowed(col, "eq") {
				d.EqCols = append(d.EqCols, rc)
			}
			if c.Name == ge.PK {
				d.PKType = rc.RType
			}
			if c.PK || c.Auto {
				d.KeyCols = append(d.KeyCols, c.Name)
			}
			// what engine/ir Validate allows for count_distinct/min/max: unstyled or ip-styled, not json/bytes
			if (len(col.Styles) == 0 || col.Styles[0] == "ip") && col.Type != "json" && col.Type != "bytes" {
				d.Aggs = append(d.Aggs, rc)
			}
		}
		rustByName := make(map[string]rustCol, len(d.Cols))
		for _, c := range d.Cols {
			rustByName[c.Name] = c
		}
		for _, f := range ge.UniqueFinders {
			rf := rustFinder{Method: f.Method, Fields: make([]rustCol, 0, len(f.Fields))}
			for _, c := range f.Fields {
				rf.Fields = append(rf.Fields, rustByName[c.Name])
			}
			d.UniqueFinders = append(d.UniqueFinders, rf)
		}
		predNames := make([]string, 0, len(e.Predicates))
		for n := range e.Predicates {
			predNames = append(predNames, n)
		}
		sort.Strings(predNames)
		for _, n := range predNames {
			pr := rustPred{Ident: rustIdent(n), Expr: e.Predicates[n].Expr}
			for i := 0; i < e.Predicates[n].Arity; i++ {
				pr.Args = append(pr.Args, fmt.Sprintf("a%d", i))
			}
			d.Preds = append(d.Preds, pr)
		}
		for _, c := range ge.ParentCols {
			col := m.Entities[parentOf(m, e, c.Name)].Column(c.Name)
			d.ParentCols = append(d.ParentCols, rustCol{goCol: c, RType: rustType(col), Ident: rustIdent(c.Name), IsStr: col.Type == "string" || col.Type == "text" || col.Type == "enum"})
		}
		for _, c := range ge.Numeric {
			col := e.Column(c.Name)
			d.Numeric = append(d.Numeric, rustCol{goCol: c, RType: rustType(col), Ident: rustIdent(c.Name)})
		}
		pairs := map[string]int{}
		for _, r := range ge.Rels {
			pairs[r.Left+"\x1f"+r.Right]++
		}
		for _, r := range ge.Rels {
			d.Rels = append(d.Rels, rustRel{Name: r.Name, Ident: rustIdent(r.Name), Target: r.Target, TargetType: r.TargetType, Kind: r.Kind, Left: r.Left, Right: r.Right, Pair: pairs[r.Left+"\x1f"+r.Right] == 1, Default: r.Default})
		}
		var buf bytes.Buffer
		if err := rustTmpl.Execute(&buf, d); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		if err := os.WriteFile(filepath.Join(src, name+".rs"), buf.Bytes(), 0o644); err != nil {
			return err
		}
		// explicit re-exports: every module also has a `cols` submodule, which must stay entity-scoped
		fmt.Fprintf(&lib, "\npub mod %s;\npub use %s::{%sRow, %sWhere, %s};\n", name, name, d.Type, d.Type, d.Type)
	}
	if err := os.WriteFile(filepath.Join(src, "lib.rs"), lib.Bytes(), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(outDir, "Cargo.toml"), []byte(rustCargo), 0o644)
}
