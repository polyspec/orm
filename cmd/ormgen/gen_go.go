package main

import (
	"bytes"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/template"

	"github.com/maxkwon/orm/engine/schema"
)

// Go generator: one file per entity in package gen, against clients/go/orm.
// Grammar: docs/dsl.md (column-first operators, or() connector, and(fn) groups,
// relation/relations/join/leftJoin by declared relation, on/where placement).

var goReserved = map[string]bool{"break": true, "case": true, "chan": true, "const": true, "continue": true, "default": true, "defer": true, "else": true, "fallthrough": true, "for": true, "func": true, "go": true, "goto": true, "if": true, "import": true, "interface": true, "map": true, "package": true, "range": true, "return": true, "select": true, "struct": true, "switch": true, "type": true, "var": true}

func pascal(s string) string {
	var b strings.Builder
	up := true
	for _, r := range s {
		if r == '_' {
			up = true
			continue
		}
		if up {
			b.WriteString(strings.ToUpper(string(r)))
			up = false
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func goType(c *schema.Col) string {
	if len(appStyles(c)) > 0 {
		return "any"
	}
	var t string
	switch c.Type {
	case "i32":
		t = "int32"
	case "i64":
		t = "int64"
	case "f64", "decimal":
		t = "float64"
	case "bool":
		t = "bool"
	case "date", "datetime":
		t = "time.Time"
	default:
		t = "string"
	}
	return t
}

// opsFor lists (Op, param kind) generated for a column: kind = one|list|pair|none.
type opDef struct {
	Suffix, Op, Kind string
}

func opsFor(c *schema.Col) []opDef {
	all := map[string]opDef{
		"eq": {"Eq", "eq", "one"}, "not_eq": {"NotEq", "not_eq", "one"}, "gt": {"Gt", "gt", "one"}, "gte": {"Gte", "gte", "one"},
		"lt": {"Lt", "lt", "one"}, "lte": {"Lte", "lte", "one"}, "in": {"In", "in", "list"}, "not_in": {"NotIn", "not_in", "list"},
		"between": {"Between", "between", "pair"}, "like": {"Like", "like", "one"}, "like_binary": {"LikeBinary", "like_binary", "one"},
		"contains": {"Contains", "contains", "one"}, "starts_with": {"StartsWith", "starts_with", "one"}, "ends_with": {"EndsWith", "ends_with", "one"},
		"is_null": {"IsNull", "is_null", "none"}, "is_not_null": {"IsNotNull", "is_not_null", "none"},
	}
	order := []string{"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "like", "like_binary", "contains", "starts_with", "ends_with", "is_null", "is_not_null"}
	var out []opDef
	for _, o := range order {
		if allowed(c, o) {
			out = append(out, all[o])
		}
	}
	return out
}

// allowed mirrors ir.OpAllowed without importing ir (keeps ormgen independent of the compiler's package graph).
func allowed(c *schema.Col, op string) bool {
	if len(c.Styles) > 0 && c.Type != "inet" {
		if c.Styles[0] == "aes" {
			return op == "eq" || op == "not_eq" || op == "in" || op == "not_in" || op == "is_null" || op == "is_not_null"
		}
		return op == "is_null" || op == "is_not_null"
	}
	byType := map[string][]string{
		"i32":    {"eq", "not_eq", "gt", "gte", "lt", "lte", "in", "not_in", "between", "is_null", "is_not_null"},
		"string": {"eq", "not_eq", "in", "not_in", "like", "like_binary", "contains", "starts_with", "ends_with", "is_null", "is_not_null"},
		"text":   {"eq", "not_eq", "like", "like_binary", "contains", "starts_with", "ends_with", "is_null", "is_not_null"},
		"enum":   {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"}, "bool": {"eq", "not_eq", "is_null", "is_not_null"},
		"inet": {"eq", "not_eq", "in", "not_in", "is_null", "is_not_null"}, "bytes": {"is_null", "is_not_null"}, "json": {"is_null", "is_not_null"}, "point": {"is_null", "is_not_null"},
	}
	for _, k := range []string{"i64", "f64", "decimal", "date", "time", "datetime"} {
		byType[k] = byType["i32"]
	}
	ops := byType[c.Type]
	if !c.Nullable && (op == "is_null" || op == "is_not_null") {
		return false
	}
	for _, o := range ops {
		if o == op {
			return true
		}
	}
	return false
}

type goEntity struct {
	Name, Type, Table string
	PK, PKType        string
	Auto              bool
	Cols              []goCol
	Rels              []goRel
	Indexes           []string
	Fulltext          [][]string
	UpdatedTs         string
	Numeric           []goCol
	ParentCols        []goCol // columns of every entity that has a relation to this one (ifParent<Col>Eq targets)
}

type goCol struct {
	Name, Field, Type, ColType string
	Nullable, Lazy, PK, Auto   bool
	Ops                        []opDef
	Styles                     []string // executor-side codec stages (docs/codec.md); the field is then `any`
}

// appStyles is the part of a column's style stack the executor handles (aes/hex/ip stay in SQL).
func appStyles(c *schema.Col) []string {
	var out []string
	for _, s := range c.Styles {
		if s != "aes" && s != "hex" && s != "ip" {
			out = append(out, s)
		}
	}
	return out
}

type goRel struct {
	Name, Method, Target, TargetType, Kind string
}

// parentOf returns the first entity related to e that has column col (ifParent targets).
func parentOf(m *schema.Manifest, e *schema.Entity, col string) string {
	for _, pn := range m.Order {
		pe := m.Entities[pn]
		for _, r := range pe.Relations {
			if r.Target == e.Name && pe.Column(col) != nil {
				return pn
			}
		}
	}
	panic("ormgen: no parent of " + e.Name + " has column " + col)
}

func buildGoEntity(m *schema.Manifest, e *schema.Entity) goEntity {
	ge := goEntity{Name: e.Name, Type: pascal(e.Name), Table: e.Table, PK: e.PK[0], Auto: e.Auto != ""}
	for _, c := range e.Columns {
		gc := goCol{Name: c.Name, Field: pascal(c.Name), Type: goType(c), ColType: c.Type, Nullable: c.Nullable, Lazy: c.Lazy, PK: c.PK, Auto: c.Auto, Ops: opsFor(c), Styles: appStyles(c)}
		if len(gc.Styles) > 0 {
			gc.Nullable = false // `any` carries nil itself
		}
		ge.Cols = append(ge.Cols, gc)
		if c.Name == e.PK[0] {
			ge.PKType = gc.Type
		}
		if c.Type == "i32" || c.Type == "i64" || c.Type == "f64" || c.Type == "decimal" {
			ge.Numeric = append(ge.Numeric, gc)
		}
	}
	names := make([]string, 0, len(e.Relations))
	for n := range e.Relations {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		r := e.Relations[n]
		ge.Rels = append(ge.Rels, goRel{Name: n, Method: pascal(n), Target: r.Target, TargetType: pascal(r.Target), Kind: r.Kind})
	}
	for n := range e.Indexes {
		ge.Indexes = append(ge.Indexes, n)
	}
	sort.Strings(ge.Indexes)
	ge.Fulltext = e.Fulltext
	if e.Timestamps != nil {
		ge.UpdatedTs = e.Timestamps.Updated
	}
	// ifParent<Col>Eq is set on the child but names a column of the parent: offer the
	// union of all possible parents' columns; the engine validates the actual pair.
	seen := map[string]bool{}
	for _, pn := range m.Order {
		pe := m.Entities[pn]
		for _, r := range pe.Relations {
			if r.Target != e.Name {
				continue
			}
			for _, c := range pe.Columns {
				if seen[c.Name] {
					continue
				}
				seen[c.Name] = true
				ge.ParentCols = append(ge.ParentCols, goCol{Name: c.Name, Field: pascal(c.Name), Type: goType(c), ColType: c.Type, Nullable: c.Nullable})
			}
		}
	}
	return ge
}

var goTmpl = template.Must(template.New("go").Funcs(template.FuncMap{
	"pascal": pascal,
	"join":   strings.Join,
	"ftName": func(cols []string) string {
		parts := make([]string, len(cols))
		for i, c := range cols {
			parts[i] = pascal(c)
		}
		return strings.Join(parts, "With")
	},
	"conv": func(goType string) string {
		switch goType {
		case "int32":
			return "int32(orm.AsInt64(v))"
		case "int64":
			return "orm.AsInt64(v)"
		case "float64":
			return "orm.AsFloat64(v)"
		case "bool":
			return "orm.AsBool(v)"
		case "time.Time":
			return "orm.AsTime(v)"
		case "any":
			return "v"
		}
		return "orm.AsString(v)"
	},
	"styleList": func(styles []string) string {
		q := make([]string, len(styles))
		for i, s := range styles {
			q[i] = fmt.Sprintf("%q", s)
		}
		return "[]string{" + strings.Join(q, ", ") + "}"
	},
	"quoteList": func(cols []string) string {
		q := make([]string, len(cols))
		for i, c := range cols {
			q[i] = fmt.Sprintf("%q", c)
		}
		return strings.Join(q, ", ")
	},
}).Parse(`// Code generated by ormgen; DO NOT EDIT.

package gen

import (
	"context"
	"time"

	"github.com/maxkwon/orm/clients/go/orm"
	"github.com/maxkwon/orm/engine/ir"
	"github.com/maxkwon/orm/engine/plan"
)

var _ time.Time

// {{.Type}}Row is one row of {{.Table}}.
type {{.Type}}Row struct {
	orm.Row
{{- range .Cols}}
	{{.Field}} {{if .Nullable}}*{{end}}{{.Type}}
{{- end}}
{{- range .Rels}}
{{- if eq .Kind "one"}}
	{{.Method}} *{{.TargetType}}Row
{{- else}}
	{{.Method}} *orm.Collection[{{.TargetType}}Row]
{{- end}}
{{- end}}
}
{{range .Cols}}
// Get{{.Field}} is nil-safe.
func (r *{{$.Type}}Row) Get{{.Field}}() {{if .Nullable}}*{{end}}{{.Type}} {
	if r == nil {
		var zero {{if .Nullable}}*{{end}}{{.Type}}
		return zero
	}
	return r.{{.Field}}
}
{{- if not .Auto}}

func (r *{{$.Type}}Row) Set{{.Field}}(v {{if .Nullable}}*{{end}}{{.Type}}) *{{$.Type}}Row {
	r.{{.Field}} = v
{{- if .Styles}}
	r.DirtyStyled({{printf "%q" .Name}}, v, {{styleList .Styles}})
{{- else}}
	r.Dirty({{printf "%q" .Name}}, {{if .Nullable}}orm.Deref(v){{else}}v{{end}})
{{- end}}
	return r
}
{{- end}}
{{end}}
{{- range .Rels}}
{{- if eq .Kind "one"}}
func (r *{{$.Type}}Row) Get{{.Method}}() *{{.TargetType}}Row { if r == nil { return nil }; return r.{{.Method}} }
{{- else}}
func (r *{{$.Type}}Row) Get{{.Method}}() *orm.Collection[{{.TargetType}}Row] { if r == nil || r.{{.Method}} == nil { return orm.NewCollection[{{.TargetType}}Row](0) }; return r.{{.Method}} }
{{- end}}
{{- end}}

// Update writes the columns changed through Set*.
func (r *{{.Type}}Row) Update(ctx context.Context, ex orm.Exec) error { return r.UpdateRow(ctx, ex, "", nil) }
{{- if .UpdatedTs}}

// UpdateOptimistic fails with OPTIMISTIC_LOCK when {{.UpdatedTs}} changed since the row was read.
func (r *{{.Type}}Row) UpdateOptimistic(ctx context.Context, ex orm.Exec) error { return r.UpdateRow(ctx, ex, {{printf "%q" .UpdatedTs}}, r.{{pascal .UpdatedTs}}) }
{{- end}}

func (r *{{.Type}}Row) Delete(ctx context.Context, ex orm.Exec) error { return r.DeleteRow(ctx, ex) }

// scan{{.Type}} maps a positional row slice onto the struct, its joined
// children (same row) and its relation children (rows of later steps).
func scan{{.Type}}(vals []any, a *plan.Assemble, rs *orm.Rows) *{{.Type}}Row {
	r := &{{.Type}}Row{}
	for _, c := range a.Columns {
		v := vals[c.Index]
		switch c.Name {
{{- range .Cols}}
		case {{printf "%q" .Name}}:
{{- if .Nullable}}
			if v != nil { x := {{conv .Type}}; r.{{.Field}} = &x }
{{- else}}
			r.{{.Field}} = {{conv .Type}}
{{- end}}
{{- end}}
		}
	}
	for _, ch := range a.Children {
		switch ch.Rel {
{{- range .Rels}}
		case {{printf "%q" .Name}}:
{{- if eq .Kind "one"}}
			if ch.Kind == "join" {
				if orm.JoinPresent(vals, ch.Assemble) { r.{{.Method}} = scan{{.TargetType}}(vals, ch.Assemble, rs) }
			} else if rows := rs.Related(ch, vals); len(rows) > 0 {
				r.{{.Method}} = scan{{.TargetType}}(rows[0], rs.StepAssemble(ch), rs)
			}
{{- else}}
			rows := rs.Related(ch, vals)
			c := orm.NewCollection[{{.TargetType}}Row](len(rows))
			for _, row := range rows { c.Put(orm.KeyOf(row[ch.KeyIndex]), scan{{.TargetType}}(row, rs.StepAssemble(ch), rs)) }
			r.{{.Method}} = c
{{- end}}
{{- end}}
		}
	}
	r.Mark({{printf "%q" .Name}}, {{printf "%q" .PK}}, r.{{pascal .PK}})
	return r
}

// {{.Type}} builds a statement over {{.Table}}: New{{.Type}}() → chain → terminal(ctx, db).
type {{.Type}} struct{ q *orm.Q }

// Req exposes the underlying request (debugging, plan inspection).
func (q *{{.Type}}) Req() *orm.Req { return q.q.Req }

func New{{.Type}}() *{{.Type}} { return &{{.Type}}{q: orm.NewQ(mustEngine(), {{printf "%q" .Name}})} }

// {{.Type}}Where edits one WHERE/ON group of {{.Table}}.
type {{.Type}}Where struct{ w *orm.W }

func (w *{{.Type}}Where) Or() *{{.Type}}Where { w.w.Or(); return w }
func (w *{{.Type}}Where) And(fn func(*{{.Type}}Where)) *{{.Type}}Where { w.w.And(func(x *orm.W) { fn(&{{.Type}}Where{w: x}) }); return w }
func (w *{{.Type}}Where) Expr(frag string, binds ...any) *{{.Type}}Where { w.w.Expr(frag, binds...); return w }
{{- range .Rels}}
func (w *{{$.Type}}Where) {{.Method}}(fn func(*{{.TargetType}}Where)) *{{$.Type}}Where { w.w.Nav({{printf "%q" .Name}}, func(x *orm.W) { fn(&{{.TargetType}}Where{w: x}) }); return w }
{{- end}}
{{range .Cols}}{{$c := .}}{{range .Ops}}
{{- if eq .Kind "one"}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}(v {{$c.Type}}) *{{$.Type}}Where { w.w.Pred({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, v); return w }
func (q *{{$.Type}}) {{$c.Field}}{{.Suffix}}(v {{$c.Type}}) *{{$.Type}} { q.q.W().Pred({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, v); return q }
{{- else if eq .Kind "list"}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}(vs []{{$c.Type}}) *{{$.Type}}Where { w.w.PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, orm.Anys(vs)); return w }
func (q *{{$.Type}}) {{$c.Field}}{{.Suffix}}(vs []{{$c.Type}}) *{{$.Type}} { q.q.W().PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, orm.Anys(vs)); return q }
{{- else if eq .Kind "pair"}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}(lo, hi {{$c.Type}}) *{{$.Type}}Where { w.w.PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, []any{lo, hi}); return w }
func (q *{{$.Type}}) {{$c.Field}}{{.Suffix}}(lo, hi {{$c.Type}}) *{{$.Type}} { q.q.W().PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, []any{lo, hi}); return q }
{{- else}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}() *{{$.Type}}Where { w.w.PredNull({{printf "%q" $c.Name}}, {{printf "%q" .Op}}); return w }
func (q *{{$.Type}}) {{$c.Field}}{{.Suffix}}() *{{$.Type}} { q.q.W().PredNull({{printf "%q" $c.Name}}, {{printf "%q" .Op}}); return q }
{{- end}}
{{- end}}{{end}}
{{- range .Fulltext}}
func (w *{{$.Type}}Where) {{ftName .}}Match(v string) *{{$.Type}}Where { w.w.Match([]string{ {{quoteList .}} }, false, v); return w }
func (w *{{$.Type}}Where) {{ftName .}}MatchBoolean(v string) *{{$.Type}}Where { w.w.Match([]string{ {{quoteList .}} }, true, v); return w }
func (q *{{$.Type}}) {{ftName .}}Match(v string) *{{$.Type}} { q.q.W().Match([]string{ {{quoteList .}} }, false, v); return q }
func (q *{{$.Type}}) {{ftName .}}MatchBoolean(v string) *{{$.Type}} { q.q.W().Match([]string{ {{quoteList .}} }, true, v); return q }
{{- end}}

// WHERE structure on the query: or() connector, and(fn) group, expr, relation navigation.
func (q *{{.Type}}) Or() *{{.Type}} { q.q.Or(); return q }
func (q *{{.Type}}) And(fn func(*{{.Type}}Where)) *{{.Type}} { q.q.W().And(func(x *orm.W) { fn(&{{.Type}}Where{w: x}) }); return q }
func (q *{{.Type}}) Expr(frag string, binds ...any) *{{.Type}} { q.q.W().Expr(frag, binds...); return q }
{{- range .Rels}}
func (q *{{$.Type}}) {{.Method}}(fn func(*{{.TargetType}}Where)) *{{$.Type}} { q.q.W().Nav({{printf "%q" .Name}}, func(x *orm.W) { fn(&{{.TargetType}}Where{w: x}) }); return q }
{{- end}}

// Join children: On = ON clause, Where = parent WHERE group. Bare predicates on a join child are rejected by the engine.
func (q *{{.Type}}) On(fn func(*{{.Type}}Where)) *{{.Type}} { fn(&{{.Type}}Where{w: q.q.OnW()}); return q }
func (q *{{.Type}}) Where(fn func(*{{.Type}}Where)) *{{.Type}} { fn(&{{.Type}}Where{w: q.q.W()}); return q }
{{range .Rels}}
func (q *{{$.Type}}) Join{{.Method}}(child *{{.TargetType}}) *{{$.Type}} { q.q.Join({{printf "%q" .Name}}, "inner", child.q); return q }
func (q *{{$.Type}}) LeftJoin{{.Method}}(child *{{.TargetType}}) *{{$.Type}} { q.q.Join({{printf "%q" .Name}}, "left", child.q); return q }
{{- if eq .Kind "one"}}
func (q *{{$.Type}}) Relation{{.Method}}(child *{{.TargetType}}) *{{$.Type}} { q.q.Relation({{printf "%q" .Name}}, child.q); return q }
{{- else}}
func (q *{{$.Type}}) Relations{{.Method}}(child *{{.TargetType}}) *{{$.Type}} { q.q.Relation({{printf "%q" .Name}}, child.q); return q }
{{- end}}
{{- end}}

// Columns.
func (q *{{.Type}}) SelectAll() *{{.Type}} { q.q.Columns().Mode = "all"; return q }
func (q *{{.Type}}) SelectNone() *{{.Type}} { q.q.Columns().Mode = "none"; return q }
func (q *{{.Type}}) SelectExpr(name, frag string) *{{.Type}} { c := q.q.Columns(); if c.Expr == nil { c.Expr = map[string]string{} }; c.Expr[name] = frag; return q }
{{- range .Cols}}
func (q *{{$.Type}}) Select{{.Field}}() *{{$.Type}} { c := q.q.Columns(); c.Add = append(c.Add, {{printf "%q" .Name}}); return q }
func (q *{{$.Type}}) Unselect{{.Field}}() *{{$.Type}} { c := q.q.Columns(); c.Remove = append(c.Remove, {{printf "%q" .Name}}); return q }
func (q *{{$.Type}}) Select{{.Field}}As(name string) *{{$.Type}} { c := q.q.Columns(); if c.As == nil { c.As = map[string]string{} }; c.As[name] = {{printf "%q" .Name}}; return q }
{{- end}}

// Order, group, limit.
{{- range .Cols}}
func (q *{{$.Type}}) OrderBy{{.Field}}Asc() *{{$.Type}} { q.q.Order({{printf "%q" .Name}}, false); return q }
func (q *{{$.Type}}) OrderBy{{.Field}}Desc() *{{$.Type}} { q.q.Order({{printf "%q" .Name}}, true); return q }
func (q *{{$.Type}}) GroupBy{{.Field}}() *{{$.Type}} { q.q.Node.GroupBy = append(q.q.Node.GroupBy, {{printf "%q" .Name}}); return q }
func (q *{{$.Type}}) KeyBy{{.Field}}() *{{$.Type}} { q.q.Node.KeyBy = {{printf "%q" .Name}}; return q }
{{- end}}
func (q *{{.Type}}) OrderByExpr(frag string, desc bool) *{{.Type}} { q.q.OrderExpr(frag, desc); return q }
func (q *{{.Type}}) Limit(offset, count int) *{{.Type}} { q.q.Node.Limit = &ir.Limit{Offset: offset, Count: count}; return q }
func (q *{{.Type}}) Distinct() *{{.Type}} { q.q.Node.Distinct = true; return q }
{{- range .Indexes}}
func (q *{{$.Type}}) ForceIndex{{pascal .}}() *{{$.Type}} { q.q.Node.ForceIdx = {{printf "%q" .}}; return q }
{{- end}}

// Relation-child options.
func (q *{{.Type}}) Flatten() *{{.Type}} { q.q.Node.Flatten = true; return q }
func (q *{{.Type}}) LimitPerParent(n int) *{{.Type}} { q.q.Node.LimitPerParent = n; return q }
func (q *{{.Type}}) DropChildKey() *{{.Type}} { q.q.Node.DropChildKey = true; return q }
{{- range .ParentCols}}{{if eq .ColType "i32" "i64" "bool" "string" "enum"}}
func (q *{{$.Type}}) IfParent{{.Field}}Eq(v {{.Type}}) *{{$.Type}} { q.q.IfParent({{printf "%q" .Name}}, v); return q }
{{- end}}{{end}}

// Insert draft.
{{- range .Cols}}{{if not .Auto}}
func (q *{{$.Type}}) Set{{.Field}}(v {{.Type}}) *{{$.Type}} { {{if .Styles}}q.q.SetStyled({{printf "%q" .Name}}, v, {{styleList .Styles}}){{else}}q.q.Set({{printf "%q" .Name}}, v){{end}}; return q }
{{- if .Nullable}}
func (q *{{$.Type}}) Set{{.Field}}Null() *{{$.Type}} { q.q.SetNull({{printf "%q" .Name}}); return q }
{{- end}}
func (q *{{$.Type}}) Set{{.Field}}Expr(frag string, binds ...any) *{{$.Type}} { q.q.SetExpr({{printf "%q" .Name}}, frag, binds...); return q }
{{- end}}{{end}}
{{- range .Numeric}}
func (q *{{$.Type}}) Plus{{.Field}}(v {{.Type}}) *{{$.Type}} { q.q.Plus({{printf "%q" .Name}}, v); return q }
func (q *{{$.Type}}) Minus{{.Field}}(v {{.Type}}) *{{$.Type}} { q.q.Minus({{printf "%q" .Name}}, v); return q }
{{- end}}

// Terminals.
func (q *{{.Type}}) One(ctx context.Context, ex orm.Exec) (*{{.Type}}Row, error) {
	q.q.Req.IR.Kind = "one"
	rows, err := orm.Query(ctx, ex, q.q.Req)
	if err != nil || len(rows.Data) == 0 {
		return nil, err
	}
	return scan{{.Type}}(rows.Data[0], rows.Assemble, rows), nil
}

func (q *{{.Type}}) All(ctx context.Context, ex orm.Exec) (*orm.Collection[{{.Type}}Row], error) {
	q.q.Req.IR.Kind = "all"
	rows, err := orm.Query(ctx, ex, q.q.Req)
	if err != nil {
		return nil, err
	}
	return collect{{.Type}}(rows), nil
}

func collect{{.Type}}(rows *orm.Rows) *orm.Collection[{{.Type}}Row] {
	c := orm.NewCollection[{{.Type}}Row](len(rows.Data))
	for _, vals := range rows.Data {
		r := scan{{.Type}}(vals, rows.Assemble, rows)
		c.Put(orm.KeyOf(vals[0]), r)
	}
	return c
}

func (q *{{.Type}}) Count(ctx context.Context, ex orm.Exec) (int64, error) {
	q.q.Req.IR.Kind = "count"
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	return orm.AsInt64(v), err
}
{{- range .Numeric}}
func (q *{{$.Type}}) Sum{{.Field}}(ctx context.Context, ex orm.Exec) (float64, error) {
	q.q.Req.IR.Kind = "sum"; q.q.Req.IR.Agg = {{printf "%q" .Name}}
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	return orm.AsFloat64(v), err
}
func (q *{{$.Type}}) Avg{{.Field}}(ctx context.Context, ex orm.Exec) (float64, error) {
	q.q.Req.IR.Kind = "avg"; q.q.Req.IR.Agg = {{printf "%q" .Name}}
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	return orm.AsFloat64(v), err
}
{{- end}}

func (q *{{.Type}}) Paginate(ctx context.Context, ex orm.Exec, page, per int) (*orm.Page[{{.Type}}Row], error) {
	if page < 1 { page = 1 }
	q.q.Req.IR.Kind = "paginate"
	q.q.Node.Limit = &ir.Limit{Offset: (page - 1) * per, Count: per}
	rows, total, err := orm.Paginate(ctx, ex, q.q.Req)
	if err != nil {
		return nil, err
	}
	pages := (total + int64(per) - 1) / int64(per)
	return &orm.Page[{{.Type}}Row]{Items: collect{{.Type}}(rows), Total: total, Pages: pages, Current: int64(page), Per: int64(per)}, nil
}

func (q *{{.Type}}) Insert(ctx context.Context, ex orm.Exec) (*{{.Type}}Row, error) {
	q.q.Req.IR.Kind = "insert"
	id, _, err := orm.Write(ctx, ex, q.q.Req)
	if err != nil {
		return nil, err
	}
{{- if .Auto}}
	return New{{.Type}}().{{pascal .PK}}Eq({{.PKType}}(id)).One(ctx, ex)
{{- else}}
	_ = id
	return nil, nil
{{- end}}
}

func (q *{{.Type}}) OneBy{{pascal .PK}}(ctx context.Context, ex orm.Exec, v {{.PKType}}) (*{{.Type}}Row, error) {
	return q.{{pascal .PK}}Eq(v).One(ctx, ex)
}
`))

const goInitFile = `// Code generated by ormgen; DO NOT EDIT.

package gen

import "github.com/maxkwon/orm/engine"

var eng *engine.Engine

// Init binds the generated package to a compiled engine (call once at startup).
func Init(e *engine.Engine) { eng = e }

func mustEngine() *engine.Engine {
	if eng == nil {
		panic("gen: call gen.Init(engine) before building queries")
	}
	return eng
}
`

func genGo(m *schema.Manifest, outDir string) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outDir, "orm_init.go"), []byte(goInitFile), 0o644); err != nil {
		return err
	}
	for _, name := range m.Order {
		e := m.Entities[name]
		ge := buildGoEntity(m, e)
		var buf bytes.Buffer
		if err := goTmpl.Execute(&buf, ge); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		src, err := format.Source(buf.Bytes())
		if err != nil {
			os.WriteFile(filepath.Join(outDir, name+".go.broken"), buf.Bytes(), 0o644)
			return fmt.Errorf("%s: gofmt: %w", name, err)
		}
		if err := os.WriteFile(filepath.Join(outDir, name+".go"), src, 0o644); err != nil {
			return err
		}
	}
	return nil
}
