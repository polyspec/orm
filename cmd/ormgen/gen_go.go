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

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/schema"
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

func finderMethod(cols []string) string {
	parts := make([]string, len(cols))
	for i, col := range cols {
		parts[i] = pascal(col)
	}
	return strings.Join(parts, "And")
}

func goType(c *schema.Col) string {
	if c.Type == "point" {
		return "orm.Point"
	}
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

// allowed is the engine's own table (engine/ir): the generator never redefines it.
func allowed(c *schema.Col, op string) bool { return ir.OpAllowed(c, op) }

// colOpsFor lists the column-to-column comparison suffixes a column supports
// (the comparison ops it allows, minus styled columns).
func colOpsFor(c *schema.Col) []opDef {
	if len(appStyles(c)) > 0 {
		return nil
	}
	var out []opDef
	for _, o := range opsFor(c) {
		switch o.Op {
		case "eq", "not_eq", "gt", "gte", "lt", "lte":
			out = append(out, opDef{Suffix: o.Suffix + "Col", Op: o.Op + "_col", Kind: "col"})
		}
	}
	return out
}

type goEntity struct {
	Name, Type, Table string
	PK, PKType        string
	Scope, ScopeType  string
	Auto              bool
	AutoCol           string
	Cols              []goCol
	DefaultCols       []goCol
	EqCols            []goCol // columns that support the default equality predicate (getsBy/getCountBy)
	UniqueFinders     []goFinder
	Rels              []goRel
	Links             []goLink
	Indexes           []string
	Fulltext          [][]string
	UpdatedTs         string
	Numeric           []goCol
	Aggs              []goCol  // countDistinct/min/max targets: not styled (ip aside), not json/bytes — the engine's rule
	Preds             []goPred // manifest predicates, by name
	ParentCols        []goCol  // columns of every entity that has a relation to this one (ifParent<Col>Eq targets)
	AESVersion        string
	AESCols           []goCol
}

// goPred is one `%% predicate` of the entity: <Method>(v…) adds expr(Expr, v…) with Arity binds.
type goPred struct {
	Name, Method, Expr string
	Arity              int
}

// aggregable mirrors the engine's min/max/count_distinct rule (engine/ir Validate):
// styled columns other than ip (a SQL-side style) and json/bytes columns are rejected.
func aggregable(c *schema.Col) bool {
	if len(c.Styles) > 0 && c.Styles[0] != "ip" {
		return false
	}
	return c.Type != "json" && c.Type != "bytes"
}

type goCol struct {
	Name, Field, Type, ColType        string
	Nullable, Lazy, PK, Auto, Managed bool
	Direct                            bool
	Ops                               []opDef
	ColOps                            []opDef  // <col><Op>Col(ref) comparisons
	Styles                            []string // executor-side codec stages (docs/codec.md); the field is then `any`
}

// goFinder is a finite, schema-declared finder shortcut for a unique key.
// Single-column equality finders are represented by EqCols.
type goFinder struct {
	Method string
	Fields []goCol
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
	Left, Right                            string // this.Left = target.Right (the PHP compat layer resolves matchAWithB against them)
	Pair                                   bool
	Default                                bool
}

type goLink struct{ Left, Right, Match, On string }

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
	ge := goEntity{Name: e.Name, Type: pascal(e.Name), Table: e.Table, PK: e.PK[0], Auto: e.Auto != "", AutoCol: e.Auto}
	hasAES := false
	for _, c := range e.Columns {
		if len(c.Styles) > 0 && c.Styles[0] == "aes" {
			hasAES = true
			break
		}
	}
	for _, c := range e.Columns {
		gc := goCol{Name: c.Name, Field: pascal(c.Name), Type: goType(c), ColType: c.Type, Nullable: c.Nullable, Lazy: c.Lazy, PK: c.PK, Auto: c.Auto, Managed: hasAES && c.Name == "aes_key_version", Ops: opsFor(c), ColOps: colOpsFor(c), Styles: appStyles(c)}
		gc.Direct = len(c.Styles) == 0 && (gc.Type == "int32" || gc.Type == "int64" || gc.Type == "float64" || gc.Type == "bool" || gc.Type == "string")
		if len(gc.Styles) > 0 {
			gc.Nullable = false // `any` carries nil itself
		}
		ge.Cols = append(ge.Cols, gc)
		if !c.Lazy {
			ge.DefaultCols = append(ge.DefaultCols, gc)
		}
		if allowed(c, "eq") {
			ge.EqCols = append(ge.EqCols, gc)
		}
		if c.Name == e.PK[0] {
			ge.PKType = gc.Type
		}
		if len(c.Styles) > 0 && c.Styles[0] == "aes" {
			ge.AESCols = append(ge.AESCols, goCol{Name: c.Name, Styles: append([]string(nil), c.Styles...)})
		}
		if c.Name == "aes_key_version" {
			ge.AESVersion = c.Name
		}
		if !gc.Managed && (c.Type == "i32" || c.Type == "i64" || c.Type == "f64" || c.Type == "decimal") {
			ge.Numeric = append(ge.Numeric, gc)
		}
		if aggregable(c) {
			ge.Aggs = append(ge.Aggs, gc)
		}
	}
	if e.Scope != "" {
		ge.Scope = e.Scope
		for _, c := range ge.Cols {
			if c.Name == e.Scope {
				ge.ScopeType = c.Type
				break
			}
		}
	}
	byName := make(map[string]goCol, len(ge.Cols))
	for _, c := range ge.Cols {
		byName[c.Name] = c
	}
	seenUnique := map[string]bool{}
	for _, cols := range e.Unique {
		key := strings.Join(cols, "\x1f")
		if seenUnique[key] || len(cols) == 0 || (len(cols) == 1 && cols[0] == ge.PK) {
			continue
		}
		seenUnique[key] = true
		fields := make([]goCol, 0, len(cols))
		for _, name := range cols {
			c, ok := byName[name]
			if !ok || !allowed(e.Column(name), "eq") {
				fields = nil
				break
			}
			fields = append(fields, c)
		}
		if len(fields) > 0 {
			ge.UniqueFinders = append(ge.UniqueFinders, goFinder{Method: finderMethod(cols), Fields: fields})
		}
	}
	pnames := make([]string, 0, len(e.Predicates))
	for n := range e.Predicates {
		pnames = append(pnames, n)
	}
	sort.Strings(pnames)
	for _, n := range pnames {
		pr := e.Predicates[n]
		ge.Preds = append(ge.Preds, goPred{Name: n, Method: pascal(n), Expr: pr.Expr, Arity: pr.Arity})
	}
	names := make([]string, 0, len(e.Relations))
	for n := range e.Relations {
		names = append(names, n)
	}
	sort.Strings(names)
	pairs := map[string]int{}
	targetKinds := map[string]int{}
	for _, n := range names {
		r := e.Relations[n]
		pairs[r.Left+"\x1f"+r.Right]++
		targetKinds[r.Target+"\x1f"+r.Kind]++
	}
	for _, n := range names {
		r := e.Relations[n]
		ge.Rels = append(ge.Rels, goRel{Name: n, Method: pascal(n), Target: r.Target, TargetType: pascal(r.Target), Kind: r.Kind, Left: r.Left, Right: r.Right, Pair: pairs[r.Left+"\x1f"+r.Right] == 1, Default: targetKinds[r.Target+"\x1f"+r.Kind] == 1})
	}
	linkPairs := map[string]bool{}
	for _, pn := range m.Order {
		pe := m.Entities[pn]
		for _, r := range pe.Relations {
			if r.Target != e.Name {
				continue
			}
			key := r.Left + "\x1f" + r.Right
			if linkPairs[key] {
				continue
			}
			linkPairs[key] = true
			ge.Links = append(ge.Links, goLink{Left: r.Left, Right: r.Right, Match: "Match" + pascal(r.Left) + "With" + pascal(r.Right), On: "On" + pascal(r.Left) + "With" + pascal(r.Right)})
		}
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
		case "orm.Point":
			return "orm.AsPoint(v)"
		case "any":
			return "v"
		}
		return "orm.AsString(v)"
	},
	"arrayExpr": func(c goCol) string {
		f := "r." + c.Field
		switch {
		case c.Type == "any":
			return f
		case c.Type == "time.Time" && c.Nullable:
			return "func() any { if " + f + " == nil { return nil }; return orm.FormatTime(*" + f + ") }()"
		case c.Type == "time.Time":
			return "orm.FormatTime(" + f + ")"
		case c.Nullable:
			return "func() any { if " + f + " == nil { return nil }; return *" + f + " }()"
		}
		return f
	},
	"predParams": func(n int) string { // "v any" | "v0 any, v1 any" | ""
		if n == 1 {
			return "v any"
		}
		parts := make([]string, n)
		for i := range parts {
			parts[i] = fmt.Sprintf("v%d any", i)
		}
		return strings.Join(parts, ", ")
	},
	"predArgs": func(n int) string { // ", v" | ", v0, v1" | ""
		if n == 1 {
			return ", v"
		}
		var b strings.Builder
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, ", v%d", i)
		}
		return b.String()
	},
	"finderParams": func(fields []goCol) string {
		parts := make([]string, len(fields))
		for i, c := range fields {
			parts[i] = fmt.Sprintf("v%d %s", i, c.Type)
		}
		return strings.Join(parts, ", ")
	},
	"finderChain": func(fields []goCol) string {
		var b strings.Builder
		b.WriteString("q")
		for i, c := range fields {
			fmt.Fprintf(&b, ".%s(v%d)", c.Field, i)
		}
		return b.String()
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

	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
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
{{- if and (not .Auto) (not .Managed)}}

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
func (r *{{.Type}}Row) Update() error { ctx, ex, err := r.Binding.Resolve(); if err != nil { return err }; return r.UpdateRow(ctx, ex, "", nil) }
{{- if .UpdatedTs}}

// UpdateOptimistic fails with OPTIMISTIC_LOCK when {{.UpdatedTs}} changed since the row was read.
func (r *{{.Type}}Row) UpdateOptimistic() error { ctx, ex, err := r.Binding.Resolve(); if err != nil { return err }; return r.UpdateRow(ctx, ex, {{printf "%q" .UpdatedTs}}, r.OriginalVersion()) }
{{- end}}

func (r *{{.Type}}Row) Delete() error { ctx, ex, err := r.Binding.Resolve(); if err != nil { return err }; return r.DeleteRow(ctx, ex) }

// DeleteCascade deletes the loaded relations this row owns (the assemble's
// cascade children, in load order, each row through its own DeleteCascade)
// and then this row. A bare DB runs the whole walk in one transaction.
func (r *{{.Type}}Row) DeleteCascade() error {
	ctx, ex, err := r.Binding.Resolve(); if err != nil { return err }
	return r.deleteCascade(ctx, ex)
}

func (r *{{.Type}}Row) deleteCascade(ctx context.Context, ex orm.Exec) error {
	return orm.InTx(ctx, ex, func(ex orm.Exec) error {
		for _, rel := range r.Cascades() {
			switch rel {
{{- range .Rels}}
			case {{printf "%q" .Name}}:
{{- if eq .Kind "one"}}
				if r.{{.Method}} != nil {
					if err := r.{{.Method}}.deleteCascade(ctx, ex); err != nil {
						return err
					}
				}
{{- else}}
				for _, child := range r.Get{{.Method}}().All() {
					if err := child.deleteCascade(ctx, ex); err != nil {
						return err
					}
				}
{{- end}}
{{- end}}
			}
		}
		return r.DeleteRow(ctx, ex)
	})
}

func assign{{.Type}}Value(r *{{.Type}}Row, name string, v any) {
	switch name {
{{- range .Cols}}
	case {{printf "%q" .Name}}:
{{- if .Nullable}}
		if v != nil { x := {{conv .Type}}; r.{{.Field}} = &x }
{{- else}}
		r.{{.Field}} = {{conv .Type}}
{{- end}}
{{- end}}
	default:
		r.SetExtra(name, v)
	}
}

func accepts{{.Type}}Direct(a *plan.Assemble) bool {
	if len(a.Columns) != {{len .DefaultCols}} { return false }
{{- range $i, $c := .DefaultCols}}
	if c := a.Columns[{{$i}}]; c.Index != {{$i}} || c.Name != {{printf "%q" $c.Name}} || c.Column != {{printf "%q" $c.Name}}{{if $c.Direct}} || len(c.Styles) != 0{{end}} { return false }
{{- end}}
	return true
}

func decode{{.Type}}Direct(s *orm.DirectScanner, c plan.OutCol, raw *orm.ScanValue, r *{{.Type}}Row) error {
	v, err := s.Decode(c, raw.Value())
	if err != nil { return err }
	assign{{.Type}}Value(r, c.Name, v)
	return nil
}

// scan{{.Type}}Direct scans the default flat projection into generated typed
// fields. Codec and datetime outputs use named temporary scan values.
func scan{{.Type}}Direct(s *orm.DirectScanner) (*{{.Type}}Row, error) {
	a := s.Assemble()
	_ = a
	r := &{{.Type}}Row{}
	r.Binding = s.Binding()
{{- range .DefaultCols}}{{if not .Direct}}
	var raw{{.Field}} orm.ScanValue
{{- end}}{{end}}
	if err := s.Scan(
{{- range .DefaultCols}}
		{{if .Direct}}&r.{{.Field}}{{else}}&raw{{.Field}}{{end}},
{{- end}}
	); err != nil { return nil, err }
{{- range $i, $c := .DefaultCols}}{{if not $c.Direct}}
	if err := decode{{$.Type}}Direct(s, a.Columns[{{$i}}], &raw{{$c.Field}}, r); err != nil { return nil, err }
{{- end}}{{end}}
	r.SetProjection(s.Projection())
	r.Mark({{printf "%q" .Name}}, {{printf "%q" .PK}}, r.{{pascal .PK}})
{{- if .UpdatedTs}}
	if r.Has({{printf "%q" .UpdatedTs}}) { r.SnapshotVersion(r.{{pascal .UpdatedTs}}) }
{{- end}}
	return r, nil
}

// scan{{.Type}} maps a positional row slice onto the struct, its joined
// children (same row) and its relation children (rows of later steps).
func scan{{.Type}}(vals []any, a *plan.Assemble, rs *orm.Rows) *{{.Type}}Row {
	r := &{{.Type}}Row{}
	r.Binding = rs.Binding
	for _, c := range a.Columns {
		assign{{.Type}}Value(r, c.Name, vals[c.Index])
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
	r.SetProjection(rs.Projection(a))
	r.Mark({{printf "%q" .Name}}, {{printf "%q" .PK}}, r.{{pascal .PK}})
{{- if .UpdatedTs}}
	if r.Has({{printf "%q" .UpdatedTs}}) { r.SnapshotVersion(r.{{pascal .UpdatedTs}}) }
{{- end}}
	return r
}

// ToArray is the row's array form (what PHP's toArray() and Rust's to_map() give):
// projected columns minus drop_child_key ones, extra outputs, loaded relations,
// and flattened one-relations merged in (this row's keys win).
func (r *{{.Type}}Row) ToArray() (map[string]any, error) {
	m := make(map[string]any, len(r.Selected()))
	for _, name := range r.Selected() {
		if r.Hidden(name) {
			continue
		}
		switch name {
{{- range .Cols}}
		case {{printf "%q" .Name}}:
			m[name] = {{arrayExpr .}}
{{- end}}
		default:
			m[name] = r.Extra(name)
		}
	}
{{- range .Rels}}
	if r.RelLoaded({{printf "%q" .Name}}) {
{{- if eq .Kind "one"}}
		if r.{{.Method}} != nil {
			child, err := r.{{.Method}}.ToArray()
			if err != nil { return nil, err }
			m[{{printf "%q" .Name}}] = child
		} else {
			m[{{printf "%q" .Name}}] = nil
		}
{{- else}}
		mm, err := r.Get{{.Method}}().ToArray()
		if err != nil { return nil, err }
		m[{{printf "%q" .Name}}] = mm
{{- end}}
	}
{{- end}}
	for _, rel := range r.Flat() {
		if child, ok := m[rel].(map[string]any); ok {
			orm.MergeFlat(m, child)
		}
	}
	return m, nil
}

// {{.Type}}Cols are column references for column-to-column predicates
// (w.SeqEqCol({{.Type}}Cols.Seq)); .At("service") points into a joined entity.
var {{.Type}}Cols = struct {
{{- range .Cols}}
	{{.Field}} orm.ColRef
{{- end}}
}{
{{- range .Cols}}
	{{.Field}}: orm.ColRef{Column: {{printf "%q" .Name}}},
{{- end}}
}

// {{.Type}}Query builds a statement over {{.Table}}: {{.Type}}() → Using(ctx, db) → chain → terminal().
type {{.Type}}Query struct {
	binding orm.Binding
	q     *orm.Q
	keyFn func(*{{.Type}}Row) orm.Key // KeyByFn: client-side keying of the root collection
}

// KeyByFn keys the root collection by a function of each row (relations key by keyBy<Col>).
func (q *{{.Type}}Query) KeyByFn(fn func(*{{.Type}}Row) orm.Key) *{{.Type}}Query { q.keyFn = fn; return q }

// Req exposes the underlying request (debugging, plan inspection).
func (q *{{.Type}}Query) Req() *orm.Req { return q.q.Req }

// {{.Type}} starts a query over {{.Table}}.
func {{.Type}}() *{{.Type}}Query { return &{{.Type}}Query{q: orm.NewQ(mustEngine(), {{printf "%q" .Name}})} }

// Using selects the context and pool or transaction for this query.
func (q *{{.Type}}Query) Using(ctx context.Context, ex orm.Exec) *{{.Type}}Query { q.binding = orm.NewBinding(ctx, ex); return q }

{{- if .AESCols}}
// AESStatus returns row counts by stored AES key version.
func (q *{{.Type}}Query) AESStatus(keyring orm.AESKeyring) (orm.AESRotationStatus, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return orm.AESRotationStatus{}, err }
	return ex.DB().AESStatus(ctx, ex, orm.AESRotationSpec{Table: {{printf "%q" .Table}}, PrimaryKey: {{printf "%q" .PK}}, VersionColumn: {{printf "%q" .AESVersion}}}, keyring)
}

// RotateAES re-encrypts every pending AES row to the keyring current version.
func (q *{{.Type}}Query) RotateAES(keyring orm.AESKeyring) (int, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return 0, err }
	return ex.DB().RotateAESRows(ctx, ex, orm.AESRotationSpec{
		Table: {{printf "%q" .Table}}, PrimaryKey: {{printf "%q" .PK}}, VersionColumn: {{printf "%q" .AESVersion}},
		Columns: []orm.AESRotationColumn{
{{- range .AESCols}}
			{Name: {{printf "%q" .Name}}, Styles: {{styleList .Styles}}},
{{- end}}
		},
	}, keyring)
}
{{- end}}

// Using selects the context and pool or transaction for this loaded row.
func (r *{{.Type}}Row) Using(ctx context.Context, ex orm.Exec) *{{.Type}}Row { r.Binding = orm.NewBinding(ctx, ex); return r }

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
func (q *{{$.Type}}Query) {{$c.Field}}{{.Suffix}}(v {{$c.Type}}) *{{$.Type}}Query { q.q.W().Pred({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, v); return q }
{{- if eq .Op "eq"}}
func (w *{{$.Type}}Where) {{$c.Field}}(v {{$c.Type}}) *{{$.Type}}Where { return w.{{$c.Field}}Eq(v) }
func (q *{{$.Type}}Query) {{$c.Field}}(v {{$c.Type}}) *{{$.Type}}Query { return q.{{$c.Field}}Eq(v) }
{{- end}}
{{- else if eq .Kind "list"}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}(vs []{{$c.Type}}) *{{$.Type}}Where { w.w.PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, orm.Anys(vs)); return w }
func (q *{{$.Type}}Query) {{$c.Field}}{{.Suffix}}(vs []{{$c.Type}}) *{{$.Type}}Query { q.q.W().PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, orm.Anys(vs)); return q }
{{- else if eq .Kind "pair"}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}(lo, hi {{$c.Type}}) *{{$.Type}}Where { w.w.PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, []any{lo, hi}); return w }
func (q *{{$.Type}}Query) {{$c.Field}}{{.Suffix}}(lo, hi {{$c.Type}}) *{{$.Type}}Query { q.q.W().PredList({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, []any{lo, hi}); return q }
{{- else}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}() *{{$.Type}}Where { w.w.PredNull({{printf "%q" $c.Name}}, {{printf "%q" .Op}}); return w }
func (q *{{$.Type}}Query) {{$c.Field}}{{.Suffix}}() *{{$.Type}}Query { q.q.W().PredNull({{printf "%q" $c.Name}}, {{printf "%q" .Op}}); return q }
{{- end}}{{end}}
{{- range $c.ColOps}}
func (w *{{$.Type}}Where) {{$c.Field}}{{.Suffix}}(ref orm.ColRef) *{{$.Type}}Where { w.w.PredCol({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, ref.Path, ref.Column); return w }
func (q *{{$.Type}}Query) {{$c.Field}}{{.Suffix}}(ref orm.ColRef) *{{$.Type}}Query { q.q.W().PredCol({{printf "%q" $c.Name}}, {{printf "%q" .Op}}, ref.Path, ref.Column); return q }
{{- end}}
{{- end}}
{{- range .Fulltext}}
func (w *{{$.Type}}Where) {{ftName .}}Match(v string) *{{$.Type}}Where { w.w.Match([]string{ {{quoteList .}} }, false, v); return w }
func (w *{{$.Type}}Where) {{ftName .}}MatchBoolean(v string) *{{$.Type}}Where { w.w.Match([]string{ {{quoteList .}} }, true, v); return w }
func (q *{{$.Type}}Query) {{ftName .}}Match(v string) *{{$.Type}}Query { q.q.W().Match([]string{ {{quoteList .}} }, false, v); return q }
func (q *{{$.Type}}Query) {{ftName .}}MatchBoolean(v string) *{{$.Type}}Query { q.q.W().Match([]string{ {{quoteList .}} }, true, v); return q }
{{- end}}
{{- range .Preds}}

// {{.Method}} is the manifest predicate {{.Name}}: {{.Expr}}
func (w *{{$.Type}}Where) {{.Method}}({{predParams .Arity}}) *{{$.Type}}Where { w.w.Expr({{printf "%q" .Expr}}{{predArgs .Arity}}); return w }
func (q *{{$.Type}}Query) {{.Method}}({{predParams .Arity}}) *{{$.Type}}Query { q.q.W().Expr({{printf "%q" .Expr}}{{predArgs .Arity}}); return q }
{{- end}}

// WHERE structure on the query: or() connector, and(fn) group, expr, relation navigation.
func (q *{{.Type}}Query) Or() *{{.Type}}Query { q.q.Or(); return q }
func (q *{{.Type}}Query) And(fn func(*{{.Type}}Where)) *{{.Type}}Query { q.q.W().And(func(x *orm.W) { fn(&{{.Type}}Where{w: x}) }); return q }
func (q *{{.Type}}Query) Expr(frag string, binds ...any) *{{.Type}}Query { q.q.W().Expr(frag, binds...); return q }
{{- if .Scope}}
func (q *{{.Type}}Query) Scope(v {{.ScopeType}}) *{{.Type}}Query { q.q.Scope(v); return q }
{{- end}}
{{- range .Rels}}
func (q *{{$.Type}}Query) {{.Method}}(fn func(*{{.TargetType}}Where)) *{{$.Type}}Query { q.q.W().Nav({{printf "%q" .Name}}, func(x *orm.W) { fn(&{{.TargetType}}Where{w: x}) }); return q }
{{- end}}

// Join children: On = ON clause, Where = parent WHERE group. Bare predicates on a join child are rejected by the engine.
func (q *{{.Type}}Query) On(fn func(*{{.Type}}Where)) *{{.Type}}Query { fn(&{{.Type}}Where{w: q.q.OnW()}); return q }
func (q *{{.Type}}Query) Where(fn func(*{{.Type}}Where)) *{{.Type}}Query { fn(&{{.Type}}Where{w: q.q.W()}); return q }

// Having is the group predicate after GroupBy<Col>: the same builder as where; aggregates go through Expr("COUNT(*) > ?", n).
func (q *{{.Type}}Query) Having(fn func(*{{.Type}}Where)) *{{.Type}}Query { fn(&{{.Type}}Where{w: q.q.HavingW()}); return q }

// Raw stores a hand-written SELECT as the root ({table} = this entity's table, ? = binds in order); RawAll runs it.
func (q *{{.Type}}Query) Raw(sql string, binds ...any) *{{.Type}}Query { q.q.Raw(sql, binds...); return q }

// Relation attaches a declared one-to-one child query. The manifest resolves
// the relation name from the parent and child entities.
func (q *{{.Type}}Query) Relation(child any) *{{.Type}}Query {
{{- range .Rels}}{{- if eq .Kind "one"}}
	if c, ok := child.(*{{.TargetType}}Query); ok { if c.q.LinkLeft != "" && (c.q.LinkLeft != "{{.Left}}" || c.q.LinkRight != "{{.Right}}") { q.q.Req.Err = &ir.Error{Code: "RELATION_UNKNOWN", Msg: "link selection does not match relation"}; return q }; q.q.Relation("{{.Name}}", c.q); return q }
{{- end}}{{- end}}
	q.q.Req.Err = &ir.Error{Code: "RELATION_UNKNOWN", Msg: "relation target or key selection is not declared"}
	return q
}
func (q *{{.Type}}Query) Relations(child any) *{{.Type}}Query {
{{- range .Rels}}{{- if eq .Kind "many"}}
	if c, ok := child.(*{{.TargetType}}Query); ok { if c.q.LinkLeft != "" && (c.q.LinkLeft != "{{.Left}}" || c.q.LinkRight != "{{.Right}}") { q.q.Req.Err = &ir.Error{Code: "RELATION_UNKNOWN", Msg: "link selection does not match relation"}; return q }; q.q.Relation("{{.Name}}", c.q); return q }
{{- end}}{{- end}}
	q.q.Req.Err = &ir.Error{Code: "RELATION_UNKNOWN", Msg: "relation target or key selection is not declared"}
	return q
}
func (q *{{.Type}}Query) Join(child any) *{{.Type}}Query { return q.joinTarget(child, "inner") }
func (q *{{.Type}}Query) LeftJoin(child any) *{{.Type}}Query { return q.joinTarget(child, "left") }
func (q *{{.Type}}Query) joinTarget(child any, kind string) *{{.Type}}Query {
{{- range .Rels}}
	if c, ok := child.(*{{.TargetType}}Query); ok { if c.q.LinkLeft != "" && (c.q.LinkLeft != "{{.Left}}" || c.q.LinkRight != "{{.Right}}") { q.q.Req.Err = &ir.Error{Code: "RELATION_UNKNOWN", Msg: "link selection does not match relation"}; return q }; q.q.Join("{{.Name}}", kind, c.q); return q }
{{- end}}
	q.q.Req.Err = &ir.Error{Code: "RELATION_UNKNOWN", Msg: "relation target or key selection is not declared"}
	return q
}
{{range .Rels}}
{{if .Pair}}
func (q *{{$.Type}}Query) Join{{pascal .Left}}With{{pascal .Right}}(child *{{.TargetType}}Query) *{{$.Type}}Query { q.q.Join("{{.Name}}", "inner", child.q); return q }
func (q *{{$.Type}}Query) LeftJoin{{pascal .Left}}With{{pascal .Right}}(child *{{.TargetType}}Query) *{{$.Type}}Query { q.q.Join("{{.Name}}", "left", child.q); return q }
{{- if eq .Kind "one"}}
func (q *{{$.Type}}Query) Relation{{pascal .Left}}With{{pascal .Right}}(child *{{.TargetType}}Query) *{{$.Type}}Query { q.q.Relation("{{.Name}}", child.q); return q }
{{- else}}
func (q *{{$.Type}}Query) Relations{{pascal .Left}}With{{pascal .Right}}(child *{{.TargetType}}Query) *{{$.Type}}Query { q.q.Relation("{{.Name}}", child.q); return q }
{{- end}}
{{- end}}
{{- end}}
{{range .Links}}
func (q *{{$.Type}}Query) {{.Match}}() *{{$.Type}}Query { q.q.SetLink("{{.Left}}", "{{.Right}}"); return q }
func (q *{{$.Type}}Query) {{.On}}() *{{$.Type}}Query { q.q.SetLink("{{.Left}}", "{{.Right}}"); return q }
{{- end}}
// Columns.
func (q *{{.Type}}Query) SelectAll() *{{.Type}}Query { q.q.Columns().Mode = "all"; return q }
func (q *{{.Type}}Query) SelectNone() *{{.Type}}Query { q.q.Columns().Mode = "none"; return q }
func (q *{{.Type}}Query) SelectExpr(name, frag string) *{{.Type}}Query { c := q.q.Columns(); if c.Expr == nil { c.Expr = map[string]string{} }; c.Expr[name] = frag; return q }
{{- range .Cols}}
func (q *{{$.Type}}Query) Select{{.Field}}() *{{$.Type}}Query { c := q.q.Columns(); c.Add = append(c.Add, {{printf "%q" .Name}}); return q }
func (q *{{$.Type}}Query) Unselect{{.Field}}() *{{$.Type}}Query { c := q.q.Columns(); c.Remove = append(c.Remove, {{printf "%q" .Name}}); return q }
func (q *{{$.Type}}Query) Select{{.Field}}As(name string) *{{$.Type}}Query { c := q.q.Columns(); if c.As == nil { c.As = map[string]string{} }; c.As[name] = {{printf "%q" .Name}}; return q }
{{- end}}

// Order, group, limit.
{{- range .Cols}}
func (q *{{$.Type}}Query) OrderBy{{.Field}}Asc() *{{$.Type}}Query { q.q.Order({{printf "%q" .Name}}, false); return q }
func (q *{{$.Type}}Query) OrderBy{{.Field}}Desc() *{{$.Type}}Query { q.q.Order({{printf "%q" .Name}}, true); return q }
func (q *{{$.Type}}Query) GroupBy{{.Field}}() *{{$.Type}}Query { q.q.Node.GroupBy = append(q.q.Node.GroupBy, {{printf "%q" .Name}}); return q }
func (q *{{$.Type}}Query) KeyBy{{.Field}}() *{{$.Type}}Query { q.q.Node.KeyBy = {{printf "%q" .Name}}; return q }
{{- end}}
func (q *{{.Type}}Query) OrderByExpr(frag string, desc bool) *{{.Type}}Query { q.q.OrderExpr(frag, desc); return q }
func (q *{{.Type}}Query) GroupByExpr(expr, as string) *{{.Type}}Query { q.q.GroupByExpr(expr, as); return q }
func (q *{{.Type}}Query) Limit(offset, count int) *{{.Type}}Query { q.q.Node.Limit = &ir.Limit{Offset: offset, Count: count}; return q }
func (q *{{.Type}}Query) Distinct() *{{.Type}}Query { q.q.Node.Distinct = true; return q }
{{- range .Indexes}}
func (q *{{$.Type}}Query) ForceIndex{{pascal .}}() *{{$.Type}}Query { q.q.Node.ForceIdx = {{printf "%q" .}}; return q }
{{- end}}

// Relation-child options.
func (q *{{.Type}}Query) Flatten() *{{.Type}}Query { q.q.Node.Flatten = true; return q }
func (q *{{.Type}}Query) LimitPerParent(n int) *{{.Type}}Query { q.q.Node.LimitPerParent = n; return q }
func (q *{{.Type}}Query) DropChildKey() *{{.Type}}Query { q.q.Node.DropChildKey = true; return q }
func (q *{{.Type}}Query) NoCascadeDelete() *{{.Type}}Query { q.q.Node.NoCascadeDelete = true; return q }
{{- range .ParentCols}}{{if eq .ColType "i32" "i64" "bool" "string" "enum"}}
func (q *{{$.Type}}Query) IfParent{{.Field}}Eq(v {{.Type}}) *{{$.Type}}Query { q.q.IfParent({{printf "%q" .Name}}, v); return q }
{{- end}}{{end}}

// Insert draft. The auto PK is settable too: Save takes it as the update key.
{{- range .Cols}}{{if not .Managed}}
func (q *{{$.Type}}Query) Set{{.Field}}(v {{.Type}}) *{{$.Type}}Query { {{if .Styles}}q.q.SetStyled({{printf "%q" .Name}}, v, {{styleList .Styles}}){{else}}q.q.Set({{printf "%q" .Name}}, v){{end}}; return q }
{{- if .Nullable}}
func (q *{{$.Type}}Query) Set{{.Field}}Null() *{{$.Type}}Query { q.q.SetNull({{printf "%q" .Name}}); return q }
{{- end}}
func (q *{{$.Type}}Query) Set{{.Field}}Expr(frag string, binds ...any) *{{$.Type}}Query { q.q.SetExpr({{printf "%q" .Name}}, frag, binds...); return q }
{{- end}}{{end}}
{{- range .Numeric}}
func (q *{{$.Type}}Query) Plus{{.Field}}(v {{.Type}}) *{{$.Type}}Query { q.q.Plus({{printf "%q" .Name}}, v); return q }
func (q *{{$.Type}}Query) Minus{{.Field}}(v {{.Type}}) *{{$.Type}}Query { q.q.Minus({{printf "%q" .Name}}, v); return q }
{{- end}}

// ON DUPLICATE KEY UPDATE assignments of an insert (never the PK/auto column).
{{- range .Cols}}{{if and (not (or .PK .Auto)) (not .Managed)}}
func (q *{{$.Type}}Query) OnDuplicateSet{{.Field}}(v {{.Type}}) *{{$.Type}}Query { {{if .Styles}}q.q.OnDuplicateStyled({{printf "%q" .Name}}, v, {{styleList .Styles}}){{else}}q.q.OnDuplicate({{printf "%q" .Name}}, v){{end}}; return q }
func (q *{{$.Type}}Query) OnDuplicateSet{{.Field}}Expr(frag string, binds ...any) *{{$.Type}}Query { q.q.OnDuplicateExpr({{printf "%q" .Name}}, frag, binds...); return q }
{{- end}}{{end}}
{{- range .Numeric}}{{if not (or .PK .Auto)}}
func (q *{{$.Type}}Query) OnDuplicatePlus{{.Field}}(v {{.Type}}) *{{$.Type}}Query { q.q.OnDuplicatePlus({{printf "%q" .Name}}, v); return q }
func (q *{{$.Type}}Query) OnDuplicateMinus{{.Field}}(v {{.Type}}) *{{$.Type}}Query { q.q.OnDuplicateMinus({{printf "%q" .Name}}, v); return q }
{{- end}}{{end}}
func (q *{{.Type}}Query) OnDuplicateSetAll() *{{.Type}}Query { q.q.OnDuplicateSetAll({{printf "%q" .PK}}{{if .Auto}}, {{printf "%q" .AutoCol}}{{end}}); return q }

// Terminals.
func (q *{{.Type}}Query) One() (*{{.Type}}Row, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "one"
	if direct, used, err := orm.QueryDirect(ctx, ex, q.q.Req, accepts{{.Type}}Direct, scan{{.Type}}Direct); used {
		if err != nil || len(direct) == 0 { return nil, err }
		return direct[0], nil
	}
	rows, err := orm.Query(ctx, ex, q.q.Req)
	if err != nil || len(rows.Data) == 0 {
		return nil, err
	}
	return scan{{.Type}}(rows.Data[0], rows.Assemble, rows), nil
}

func (q *{{.Type}}Query) All() (*orm.Collection[{{.Type}}Row], error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "all"
	if direct, used, err := orm.QueryDirect(ctx, ex, q.q.Req, accepts{{.Type}}Direct, scan{{.Type}}Direct); used {
		if err != nil { return nil, err }
		return collect{{.Type}}Direct(direct, q.keyFn), nil
	}
	rows, err := orm.Query(ctx, ex, q.q.Req)
	if err != nil {
		return nil, err
	}
	return collect{{.Type}}(rows, q.keyFn), nil
}

// Get is the preferred single-row terminal. One is kept as a compatibility alias.
func (q *{{.Type}}Query) Get() (*{{.Type}}Row, error) {
	return q.One()
}

// Gets is the preferred collection terminal. All is kept as a compatibility alias.
func (q *{{.Type}}Query) Gets() (*orm.Collection[{{.Type}}Row], error) {
	return q.All()
}

// Stream visits independently owned rows without accumulating the complete result.
// Returning false stops the query and closes its database cursor.
func (q *{{.Type}}Query) Stream(visit func(*{{.Type}}Row) bool) (orm.StreamResult, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return orm.StreamResult{}, err }
	if visit == nil { return orm.StreamResult{}, &ir.Error{Code: orm.CodeIrInvalid, Msg: "stream visitor is required"} }
	q.q.Req.IR.Kind = "all"
	return orm.Stream(ctx, ex, q.q.Req, func(vals []any, rows *orm.Rows) bool {
		return visit(scan{{.Type}}(vals, rows.Assemble, rows))
	})
}

{{range .EqCols}}
// GetsBy{{.Field}} applies {{.Name}} = v and runs the collection terminal.
func (q *{{$.Type}}Query) GetsBy{{.Field}}(v {{.Type}}) (*orm.Collection[{{$.Type}}Row], error) {
	return q.{{.Field}}(v).Gets()
}
{{end}}
func collect{{.Type}}(rows *orm.Rows, keyFn func(*{{.Type}}Row) orm.Key) *orm.Collection[{{.Type}}Row] {
	c := orm.NewCollection[{{.Type}}Row](len(rows.Data))
	for _, vals := range rows.Data {
		r := scan{{.Type}}(vals, rows.Assemble, rows)
		if keyFn != nil {
			c.Put(keyFn(r), r)
			continue
		}
		c.Put(orm.KeyOf(vals[0]), r)
	}
	return c
}

func collect{{.Type}}Direct(rows []*{{.Type}}Row, keyFn func(*{{.Type}}Row) orm.Key) *orm.Collection[{{.Type}}Row] {
	c := orm.NewCollection[{{.Type}}Row](len(rows))
	for _, r := range rows {
		if keyFn != nil { c.Put(keyFn(r), r) } else { c.Put(orm.KeyOf(r.{{pascal .PK}}), r) }
	}
	return c
}

func (q *{{.Type}}Query) Count() (int64, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return 0, err }
	q.q.Req.IR.Kind = "count"
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	return orm.AsInt64(v), err
}

// GetCount is the preferred scalar count terminal. Count is kept as a compatibility alias.
func (q *{{.Type}}Query) GetCount() (int64, error) {
	return q.Count()
}

{{range .EqCols}}
// GetCountBy{{.Field}} applies {{.Name}} = v and runs the scalar count terminal.
func (q *{{$.Type}}Query) GetCountBy{{.Field}}(v {{.Type}}) (int64, error) {
	return q.{{.Field}}(v).GetCount()
}
{{end}}
// GetsCount returns one row per group_by value. The grouped columns are in the
// row and the aggregate is available as Extra("row_count").
func (q *{{.Type}}Query) GetsCount() (*orm.Collection[{{.Type}}Row], error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "group_count"
	rows, err := orm.Query(ctx, ex, q.q.Req)
	if err != nil {
		return nil, err
	}
	return collect{{.Type}}(rows, q.keyFn), nil
}
{{- range .Numeric}}
func (q *{{$.Type}}Query) Sum{{.Field}}() (float64, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return 0, err }
	q.q.Req.IR.Kind = "sum"; q.q.Req.IR.Agg = {{printf "%q" .Name}}
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	return orm.AsFloat64(v), err
}
func (q *{{$.Type}}Query) Avg{{.Field}}() (float64, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return 0, err }
	q.q.Req.IR.Kind = "avg"; q.q.Req.IR.Agg = {{printf "%q" .Name}}
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	return orm.AsFloat64(v), err
}
{{- end}}
{{- range .Aggs}}
func (q *{{$.Type}}Query) CountDistinct{{.Field}}() (int64, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return 0, err }
	q.q.Req.IR.Kind = "count_distinct"; q.q.Req.IR.Agg = {{printf "%q" .Name}}
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	return orm.AsInt64(v), err
}
// Min{{.Field}} is nil when no row matches.
func (q *{{$.Type}}Query) Min{{.Field}}() (*{{.Type}}, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "min"; q.q.Req.IR.Agg = {{printf "%q" .Name}}
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	if err != nil || v == nil {
		return nil, err
	}
	x := {{conv .Type}}
	return &x, nil
}
// Max{{.Field}} is nil when no row matches.
func (q *{{$.Type}}Query) Max{{.Field}}() (*{{.Type}}, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "max"; q.q.Req.IR.Agg = {{printf "%q" .Name}}
	v, err := orm.Scalar(ctx, ex, q.q.Req)
	if err != nil || v == nil {
		return nil, err
	}
	x := {{conv .Type}}
	return &x, nil
}
{{- end}}

// RawAll runs the statement given to Raw and returns its rows by column name (values as the driver gives them, no codec).
func (q *{{.Type}}Query) RawAll() ([]map[string]any, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "raw"
	return orm.RawAll(ctx, ex, q.q.Req)
}

func (q *{{.Type}}Query) Paginate(page, per int) (*orm.Page[{{.Type}}Row], error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	if per <= 0 { return nil, &ir.Error{Code: "IR_INVALID", Msg: "per must be positive"} }
	if page < 1 { page = 1 }
	q.q.Req.IR.Kind = "paginate"
	q.q.Node.Limit = &ir.Limit{Offset: (page - 1) * per, Count: per}
	rows, total, err := orm.Paginate(ctx, ex, q.q.Req)
	if err != nil {
		return nil, err
	}
	pages := (total + int64(per) - 1) / int64(per)
	return &orm.Page[{{.Type}}Row]{Items: collect{{.Type}}(rows, q.keyFn), Total: total, Pages: pages, Current: int64(page), Per: int64(per)}, nil
}

func (q *{{.Type}}Query) Insert() (*{{.Type}}Row, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "insert"
	id, _, err := orm.Write(ctx, ex, q.q.Req)
	if err != nil {
		return nil, err
	}
{{- if .Auto}}
	return {{.Type}}().Using(ctx, ex).{{pascal .PK}}Eq({{.PKType}}(id)).One()
{{- else}}
	_ = id
	return nil, nil
{{- end}}
}

// Save updates the other assigned columns when Set{{pascal .PK}} was called (and
// returns the re-read row); otherwise it inserts like Insert.
func (q *{{.Type}}Query) Save() (*{{.Type}}Row, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	pk, ok := q.q.MovePKToWhere({{printf "%q" .PK}})
	if !ok {
		return q.Insert()
	}
	q.q.Req.IR.Kind = "update"
	if _, _, err := orm.Write(ctx, ex, q.q.Req); err != nil {
		return nil, err
	}
	return {{.Type}}().Using(ctx, ex).{{pascal .PK}}Eq(pk.({{.PKType}})).One()
}

// Update applies the draft's assignments to every row the WHERE matches (the engine rejects a missing WHERE).
func (q *{{.Type}}Query) Update() (int64, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return 0, err }
	q.q.Req.IR.Kind = "update"
	_, affected, err := orm.Write(ctx, ex, q.q.Req)
	return affected, err
}

// Delete removes every row the WHERE matches (the engine rejects a missing WHERE).
func (q *{{.Type}}Query) Delete() (int64, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return 0, err }
	q.q.Req.IR.Kind = "delete"
	_, affected, err := orm.Write(ctx, ex, q.q.Req)
	return affected, err
}

// SQL renders the main statement as All would run it, without executing: secret binds show as "$SECRET".
func (q *{{.Type}}Query) SQL() (*orm.Statement, error) {
	ctx, ex, err := q.binding.Resolve(); if err != nil { return nil, err }
	q.q.Req.IR.Kind = "all"
	return orm.SQL(ctx, ex, q.q.Req)
}

func (q *{{.Type}}Query) OneBy{{pascal .PK}}(v {{.PKType}}) (*{{.Type}}Row, error) {
	return q.{{pascal .PK}}Eq(v).One()
}

// GetBy{{pascal .PK}} is the preferred primary-key lookup. OneBy{{pascal .PK}} is kept as a compatibility alias.
func (q *{{.Type}}Query) GetBy{{pascal .PK}}(v {{.PKType}}) (*{{.Type}}Row, error) {
	return q.OneBy{{pascal .PK}}(v)
}
{{range .UniqueFinders}}
// GetBy{{.Method}} applies the equality predicates for the declared unique key.
func (q *{{$.Type}}Query) GetBy{{.Method}}({{finderParams .Fields}}) (*{{$.Type}}Row, error) {
	return {{finderChain .Fields}}.Get()
}
{{end}}
`))

const goInitFile = `// Code generated by ormgen; DO NOT EDIT.

package gen

import (
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
)

// SchemaHash is the schema_hash of the schema.json this package was generated from.
const SchemaHash = "%s"

var eng *engine.Engine

// Init binds the generated package to a compiled engine (call once at startup).
// It checks, exactly once, that the engine loaded the schema this package was
// generated from: SCHEMA_HASH_MISMATCH otherwise (no watching, no reload).
func Init(e *engine.Engine) error {
	if err := orm.CheckSchemaHash(e, SchemaHash); err != nil {
		return err
	}
	eng = e
	return nil
}

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
	if err := os.WriteFile(filepath.Join(outDir, "orm_init.go"), []byte(fmt.Sprintf(goInitFile, m.SchemaHash)), 0o644); err != nil {
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
