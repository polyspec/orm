// Package planner turns a validated IR request into a Plan.
//
// S1 scope: one/all/count/sum/avg/paginate over a root entity with nested
// joins; insert/update/delete. Relations (separate IN steps) arrive in S2 and
// hook into Assemble.Children.
package planner

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/maxkwon/orm/engine/dialect"
	"github.com/maxkwon/orm/engine/ir"
	"github.com/maxkwon/orm/engine/plan"
	"github.com/maxkwon/orm/engine/schema"
)

type Planner struct {
	M *schema.Manifest
	D dialect.Dialect
}

// scope is one entity occurrence in a statement (root or a join) with its alias.
type scope struct {
	ent    *schema.Entity
	alias  string
	q      *ir.Query
	joins  map[string]*scope
	parent *scope
}

type builder struct {
	p     *Planner
	binds []plan.BindSlot
	n     int
}

func (b *builder) param(i int) string {
	b.binds = append(b.binds, plan.BindSlot{From: "param", Param: i})
	b.n++
	return b.p.D.Placeholder(b.n)
}

func (b *builder) paramT(i int, transform string) string {
	b.binds = append(b.binds, plan.BindSlot{From: "param", Param: i, Transform: transform})
	b.n++
	return b.p.D.Placeholder(b.n)
}

func (b *builder) secret(name string) string {
	b.binds = append(b.binds, plan.BindSlot{From: "secret", Name: name})
	b.n++
	return b.p.D.Placeholder(b.n)
}

func (p *Planner) Compile(r *ir.Request) (*plan.Plan, error) {
	out := &plan.Plan{SchemaHash: p.M.SchemaHash, Kind: r.Kind}
	switch r.Kind {
	case "one", "all", "count", "sum", "avg":
		st, err := p.selectStep(r, r.Kind, 0)
		if err != nil {
			return nil, err
		}
		out.Steps = append(out.Steps, *st)
	case "paginate":
		main, err := p.selectStep(r, "all", 0)
		if err != nil {
			return nil, err
		}
		cnt, err := p.selectStep(r, "count", 1)
		if err != nil {
			return nil, err
		}
		out.Steps = append(out.Steps, *main, *cnt)
	case "insert":
		st, err := p.insertStep(r)
		if err != nil {
			return nil, err
		}
		out.Steps = append(out.Steps, *st)
	case "update":
		st, err := p.updateStep(r)
		if err != nil {
			return nil, err
		}
		out.Steps = append(out.Steps, *st)
	case "delete":
		st, err := p.deleteStep(r)
		if err != nil {
			return nil, err
		}
		out.Steps = append(out.Steps, *st)
	}
	return out, nil
}

// buildScopes assigns deterministic aliases: root "a", joins by relation name
// (nested joins prefixed by their parent's alias: "campaign__service").
func (p *Planner) buildScopes(q *ir.Query, alias string, parent *scope) *scope {
	s := &scope{ent: p.M.Entities[q.Entity], alias: alias, q: q, joins: map[string]*scope{}, parent: parent}
	for _, j := range q.Joins {
		ja := j.Rel
		if parent != nil || alias != "a" {
			ja = alias + "__" + j.Rel
		}
		s.joins[j.Rel] = p.buildScopes(j.Query, ja, s)
	}
	return s
}

func (p *Planner) selectStep(r *ir.Request, kind string, id int) (*plan.Step, error) {
	b := &builder{p: p}
	root := p.buildScopes(&r.Query, "a", nil)
	var sb strings.Builder
	sb.WriteString("SELECT ")
	if r.Distinct && kind != "count" {
		sb.WriteString("DISTINCT ")
	}
	asm := &plan.Assemble{Entity: root.ent.Name, Alias: root.alias}
	switch kind {
	case "count":
		if len(r.GroupBy) > 0 || r.Distinct {
			sb.WriteString("COUNT(DISTINCT " + p.qcol(root, root.ent.PK[0]) + ")")
		} else {
			sb.WriteString("COUNT(*)")
		}
	case "sum":
		sb.WriteString("COALESCE(SUM(" + p.qcol(root, r.Agg) + "), 0)")
	case "avg":
		sb.WriteString("AVG(" + p.qcol(root, r.Agg) + ")")
	default:
		idx := 0
		if err := p.selectList(b, &sb, root, asm, &idx, true); err != nil {
			return nil, err
		}
	}
	sb.WriteString(" FROM " + p.D.Quote(root.ent.Table) + " AS " + p.D.Quote(root.alias))
	if r.ForceIdx != "" {
		sb.WriteString(p.D.ForceIndex(r.ForceIdx))
	}
	if err := p.renderJoins(b, &sb, root); err != nil {
		return nil, err
	}
	// WHERE = root group, then each join's where group as an AND group (declaration order).
	var where []string
	if r.Where != nil && len(r.Where.Items) > 0 {
		s, err := p.renderGroup(b, root, r.Where, true)
		if err != nil {
			return nil, err
		}
		where = append(where, s)
	}
	if err := p.collectJoinWhere(b, root, &where); err != nil {
		return nil, err
	}
	if len(where) > 0 {
		sb.WriteString(" WHERE " + strings.Join(where, " AND "))
	}
	if kind != "count" && kind != "sum" && kind != "avg" || len(r.GroupBy) > 0 && kind == "count" {
		if len(r.GroupBy) > 0 && kind != "count" {
			sb.WriteString(" GROUP BY ")
			for i, g := range r.GroupBy {
				if i > 0 {
					sb.WriteString(", ")
				}
				sb.WriteString(p.qcol(root, g))
			}
		}
	}
	if kind == "one" || kind == "all" {
		if len(r.Order) > 0 {
			sb.WriteString(" ORDER BY ")
			for i, o := range r.Order {
				if i > 0 {
					sb.WriteString(", ")
				}
				if o.Expr != "" {
					s, err := p.renderExpr(root, o.Expr)
					if err != nil {
						return nil, err
					}
					sb.WriteString(s)
				} else {
					sb.WriteString(p.qcol(root, o.Column))
				}
				if o.Desc {
					sb.WriteString(" DESC")
				} else {
					sb.WriteString(" ASC")
				}
			}
		}
		switch {
		case kind == "one":
			sb.WriteString(p.D.Limit(0, 1))
		case r.Limit != nil:
			sb.WriteString(p.D.Limit(r.Limit.Offset, r.Limit.Count))
		}
	}
	st := &plan.Step{ID: id, Role: "main", SQL: sb.String(), BindSlots: b.binds}
	if id == 1 {
		st.Role = "count"
	}
	if kind == "one" || kind == "all" {
		st.Assemble = asm
	}
	return st, nil
}

// selectList writes the projection for a scope and its joins, recording the
// positional mapping in asm. Join columns become Child{kind: join}.
func (p *Planner) selectList(b *builder, sb *strings.Builder, s *scope, asm *plan.Assemble, idx *int, first bool) error {
	cols, err := p.projection(s)
	if err != nil {
		return err
	}
	for _, c := range cols {
		if *idx > 0 {
			sb.WriteString(", ")
		}
		col := s.ent.Column(c.column)
		var expr string
		var styles []string
		switch {
		case c.expr != "":
			e, err := p.renderExpr(s, c.expr)
			if err != nil {
				return err
			}
			expr = e
		default:
			e, _ := p.D.ReadExpr(p.qcol(s, c.column), sqlStyles(col.Styles), func() string { return b.secret("aes") })
			expr = e
			styles = appStyles(col.Styles)
		}
		sb.WriteString(expr + " AS " + p.D.Quote(s.alias+"__"+c.name))
		typ := "string"
		if col != nil {
			typ = col.Type
		}
		asm.Columns = append(asm.Columns, plan.OutCol{Index: *idx, Name: c.name, Column: c.column, Type: typ, Styles: styles})
		*idx++
	}
	for _, j := range s.q.Joins {
		js := s.joins[j.Rel]
		child := &plan.Child{Rel: j.Rel, Kind: "join", Assemble: &plan.Assemble{Entity: js.ent.Name, Alias: js.alias}}
		if err := p.selectList(b, sb, js, child.Assemble, idx, false); err != nil {
			return err
		}
		asm.Children = append(asm.Children, child)
	}
	return nil
}

type outCol struct{ name, column, expr string }

// projection resolves columns mode/add/remove/as/expr into an ordered list.
func (p *Planner) projection(s *scope) ([]outCol, error) {
	c := s.q.Columns
	var base []string
	mode := ""
	if c != nil {
		mode = c.Mode
	}
	for _, col := range s.ent.Columns {
		switch mode {
		case "all":
			base = append(base, col.Name)
		case "none":
			if col.PK || col.FK {
				base = append(base, col.Name)
			}
		default:
			if !col.Lazy {
				base = append(base, col.Name)
			}
		}
	}
	if c != nil {
		for _, a := range c.Add {
			if !contains(base, a) {
				base = append(base, a)
			}
		}
		if len(c.Remove) > 0 {
			var kept []string
			for _, x := range base {
				if !contains(c.Remove, x) || s.ent.Column(x).PK {
					kept = append(kept, x)
				}
			}
			base = kept
		}
	}
	// PK is always selected (needed for keying and relation binding).
	for _, pk := range s.ent.PK {
		if !contains(base, pk) {
			base = append([]string{pk}, base...)
		}
	}
	var out []outCol
	for _, x := range base {
		out = append(out, outCol{name: x, column: x})
	}
	if c != nil {
		for _, name := range sortedKeys(c.As) {
			out = append(out, outCol{name: name, column: c.As[name]})
		}
		for _, name := range sortedKeys(c.Expr) {
			out = append(out, outCol{name: name, expr: c.Expr[name]})
		}
	}
	return out, nil
}

func (p *Planner) renderJoins(b *builder, sb *strings.Builder, s *scope) error {
	for _, j := range s.q.Joins {
		js := s.joins[j.Rel]
		rel := s.ent.Relations[j.Rel]
		kw := " INNER JOIN "
		if j.Kind == "left" {
			kw = " LEFT JOIN "
		}
		sb.WriteString(kw + p.D.Quote(js.ent.Table) + " AS " + p.D.Quote(js.alias) + " ON " +
			p.qcol(s, rel.Left) + " = " + p.qcol(js, rel.Right))
		if j.Query.On != nil && len(j.Query.On.Items) > 0 {
			on, err := p.renderGroup(b, js, j.Query.On, true)
			if err != nil {
				return err
			}
			sb.WriteString(" AND " + on)
		}
		if err := p.renderJoins(b, sb, js); err != nil {
			return err
		}
	}
	return nil
}

// collectJoinWhere appends each join child's where group (and its nested joins') as "(…)".
func (p *Planner) collectJoinWhere(b *builder, s *scope, where *[]string) error {
	for _, j := range s.q.Joins {
		js := s.joins[j.Rel]
		if j.Query.Where != nil && len(j.Query.Where.Items) > 0 {
			g, err := p.renderGroup(b, js, j.Query.Where, false)
			if err != nil {
				return err
			}
			*where = append(*where, g)
		}
		if err := p.collectJoinWhere(b, js, where); err != nil {
			return err
		}
	}
	return nil
}

// renderGroup writes a group; top omits the outer parentheses.
func (p *Planner) renderGroup(b *builder, s *scope, g *ir.Group, top bool) (string, error) {
	var parts []string
	for i, it := range g.Items {
		conn, text := "", ""
		var err error
		switch {
		case it.Pred != nil:
			conn = it.Pred.Conn
			text, err = p.renderPred(b, s, it.Pred)
		case it.Group != nil:
			conn = it.Group.Conn
			text, err = p.renderGroup(b, s, it.Group, false)
		case it.Nav != nil:
			conn = it.Nav.Conn
			js := s.joins[it.Nav.Rel]
			text, err = p.renderGroup(b, js, it.Nav.Group, false)
		}
		if err != nil {
			return "", err
		}
		if i > 0 {
			if conn == "or" {
				parts = append(parts, "OR")
			} else {
				parts = append(parts, "AND")
			}
		}
		parts = append(parts, text)
	}
	out := strings.Join(parts, " ")
	if !top {
		out = "(" + out + ")"
	}
	return out, nil
}

func (p *Planner) renderPred(b *builder, s *scope, pr *ir.Pred) (string, error) {
	if pr.Expr != "" {
		e, err := p.renderExpr(s, pr.Expr)
		if err != nil {
			return "", err
		}
		// expr binds are positional '?' in the fragment, in order
		for _, i := range pr.Ps {
			b.param(i)
		}
		return "(" + e + ")", nil
	}
	if pr.Op == "match" || pr.Op == "match_boolean" {
		var cols []string
		for _, c := range pr.Match {
			cols = append(cols, p.qcol(s, c))
		}
		boolean := pr.Op == "match_boolean"
		transform := ""
		if boolean {
			transform = "fulltext_boolean"
		}
		return p.D.Fulltext(cols, b.paramT(*pr.P, transform), boolean), nil
	}
	col := s.ent.Column(pr.Column)
	lhs := p.qcol(s, pr.Column)
	switch pr.Op {
	case "eq", "not_eq", "gt", "gte", "lt", "lte":
		rhs, err := p.renderValue(b, col, *pr.P)
		if err != nil {
			return "", err
		}
		return lhs + " " + cmp(pr.Op) + " " + rhs, nil
	case "eq_col", "not_eq_col", "gt_col", "gte_col", "lt_col", "lte_col":
		rs, err := p.resolvePath(s, pr.Ref.Path)
		if err != nil {
			return "", err
		}
		if rs.ent.Column(pr.Ref.Column) == nil {
			return "", &ir.Error{Code: "COLUMN_UNKNOWN", Msg: rs.ent.Name + "." + pr.Ref.Column}
		}
		return lhs + " " + cmp(strings.TrimSuffix(pr.Op, "_col")) + " " + p.qcol(rs, pr.Ref.Column), nil
	case "in", "not_in":
		var phs []string
		for _, i := range pr.Ps {
			rhs, err := p.renderValue(b, col, i)
			if err != nil {
				return "", err
			}
			phs = append(phs, rhs)
		}
		op := "IN"
		if pr.Op == "not_in" {
			op = "NOT IN"
		}
		return lhs + " " + op + " (" + strings.Join(phs, ", ") + ")", nil
	case "between":
		lo, err := p.renderValue(b, col, pr.Ps[0])
		if err != nil {
			return "", err
		}
		hi, err := p.renderValue(b, col, pr.Ps[1])
		if err != nil {
			return "", err
		}
		return lhs + " BETWEEN " + lo + " AND " + hi, nil
	case "is_null":
		return lhs + " IS NULL", nil
	case "is_not_null":
		return lhs + " IS NOT NULL", nil
	case "like", "like_binary":
		return p.D.Like(lhs, b.param(*pr.P), pr.Op == "like_binary"), nil
	case "contains":
		return p.D.Like(lhs, b.paramT(*pr.P, "like_contains"), false), nil
	case "starts_with":
		return p.D.Like(lhs, b.paramT(*pr.P, "like_starts"), false), nil
	case "ends_with":
		return p.D.Like(lhs, b.paramT(*pr.P, "like_ends"), false), nil
	}
	return "", &ir.Error{Code: "OPERATOR_UNKNOWN", Msg: pr.Op}
}

// renderValue binds one value, wrapping it for SQL-side styles (aes/hex/ip) so
// equality predicates on encrypted columns keep working (compatibility behaviour).
func (p *Planner) renderValue(b *builder, col *schema.Col, i int) (string, error) {
	styles := sqlStyles(col.Styles)
	if len(styles) == 0 {
		return b.param(i), nil
	}
	first := true
	e, _ := p.D.WriteExpr(func() string {
		if first {
			first = false
			return b.param(i)
		}
		return b.secret("aes")
	}, styles)
	return e, nil
}

func (p *Planner) resolvePath(s *scope, path string) (*scope, error) {
	if path == "" {
		// "" means the parent of a join child's on(), or the root
		if s.parent != nil {
			return s.parent, nil
		}
		return s, nil
	}
	cur := s
	for cur.parent != nil {
		cur = cur.parent
	}
	for _, seg := range strings.Split(path, "/") {
		next, ok := cur.joins[seg]
		if !ok {
			return nil, &ir.Error{Code: "ENTITY_NOT_JOINED", Msg: cur.ent.Name + "." + seg}
		}
		cur = next
	}
	return cur, nil
}

// renderExpr checks backtick-quoted column names in a fragment against the
// scope's entity and rewrites them as alias-qualified identifiers.
func (p *Planner) renderExpr(s *scope, frag string) (string, error) {
	var out strings.Builder
	i := 0
	for i < len(frag) {
		if frag[i] != '`' {
			out.WriteByte(frag[i])
			i++
			continue
		}
		j := strings.IndexByte(frag[i+1:], '`')
		if j < 0 {
			return "", &ir.Error{Code: "IR_INVALID", Msg: "unterminated ` in expr"}
		}
		name := frag[i+1 : i+1+j]
		if s.ent.Column(name) == nil {
			return "", &ir.Error{Code: "COLUMN_UNKNOWN", Msg: s.ent.Name + "." + name + " in expr"}
		}
		out.WriteString(p.qcol(s, name))
		i += j + 2
	}
	return out.String(), nil
}

func (p *Planner) insertStep(r *ir.Request) (*plan.Step, error) {
	b := &builder{p: p}
	ent := p.M.Entities[r.Entity]
	var cols, vals []string
	for _, a := range r.Set {
		col := ent.Column(a.Column)
		if col.Auto {
			return nil, &ir.Error{Code: "IR_INVALID", Msg: "cannot set auto column " + a.Column}
		}
		cols = append(cols, p.D.Quote(a.Column))
		v, err := p.renderAssign(b, ent, col, &a)
		if err != nil {
			return nil, err
		}
		vals = append(vals, v)
	}
	sql := "INSERT INTO " + p.D.Quote(ent.Table) + " (" + strings.Join(cols, ", ") + ") VALUES (" + strings.Join(vals, ", ") + ")"
	if p.D.InsertReturningID() && ent.Auto != "" {
		sql += " RETURNING " + p.D.Quote(ent.Auto)
	}
	return &plan.Step{ID: 0, Role: "main", SQL: sql, BindSlots: b.binds}, nil
}

func (p *Planner) renderAssign(b *builder, ent *schema.Entity, col *schema.Col, a *ir.Assign) (string, error) {
	switch {
	case a.Expr != "":
		e, err := p.renderExpr(&scope{ent: ent, alias: ent.Table}, a.Expr)
		if err != nil {
			return "", err
		}
		for _, i := range a.Ps {
			b.param(i)
		}
		return e, nil
	case a.PlusP != nil:
		return p.D.Quote(col.Name) + " + " + b.param(*a.PlusP), nil
	case a.MinusP != nil:
		// clamp at zero, as compatibility does
		q := p.D.Quote(col.Name)
		ph := b.param(*a.MinusP)
		return "CASE WHEN " + q + " > " + ph + " THEN " + q + " - " + b.param(*a.MinusP) + " ELSE 0 END", nil
	case a.Null:
		return "NULL", nil
	default:
		return p.renderValue(b, col, *a.P)
	}
}

func (p *Planner) updateStep(r *ir.Request) (*plan.Step, error) {
	b := &builder{p: p}
	ent := p.M.Entities[r.Entity]
	root := p.buildScopes(&r.Query, ent.Table, nil)
	var sets []string
	for _, a := range r.Set {
		col := ent.Column(a.Column)
		if col.PK || col.Auto {
			return nil, &ir.Error{Code: "IR_INVALID", Msg: "cannot update " + a.Column}
		}
		v, err := p.renderAssign(b, ent, col, &a)
		if err != nil {
			return nil, err
		}
		sets = append(sets, p.D.Quote(a.Column)+" = "+v)
	}
	where, err := p.renderGroup(b, root, r.Where, true)
	if err != nil {
		return nil, err
	}
	if r.Optimistic != nil {
		where += " AND " + p.qcol(root, r.Optimistic.Column) + " = " + b.param(r.Optimistic.P)
	}
	sql := "UPDATE " + p.D.Quote(ent.Table) + " SET " + strings.Join(sets, ", ") + " WHERE " + where
	return &plan.Step{ID: 0, Role: "main", SQL: sql, BindSlots: b.binds}, nil
}

func (p *Planner) deleteStep(r *ir.Request) (*plan.Step, error) {
	b := &builder{p: p}
	ent := p.M.Entities[r.Entity]
	root := p.buildScopes(&r.Query, ent.Table, nil)
	where, err := p.renderGroup(b, root, r.Where, true)
	if err != nil {
		return nil, err
	}
	sql := "DELETE FROM " + p.D.Quote(ent.Table) + " WHERE " + where
	return &plan.Step{ID: 0, Role: "main", SQL: sql, BindSlots: b.binds}, nil
}

func (p *Planner) qcol(s *scope, col string) string {
	return p.D.Quote(s.alias) + "." + p.D.Quote(col)
}

func cmp(op string) string {
	switch op {
	case "eq":
		return "="
	case "not_eq":
		return "!="
	case "gt":
		return ">"
	case "gte":
		return ">="
	case "lt":
		return "<"
	case "lte":
		return "<="
	}
	panic("cmp: " + op)
}

// sqlStyles keeps only stages the dialect handles in SQL; appStyles the rest.
func sqlStyles(styles []string) []string {
	var out []string
	for _, s := range styles {
		if s == "aes" || s == "hex" || s == "ip" {
			out = append(out, s)
		}
	}
	return out
}

func appStyles(styles []string) []string {
	var out []string
	for _, s := range styles {
		if s != "aes" && s != "hex" && s != "ip" {
			out = append(out, s)
		}
	}
	return out
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// deterministic output for plan caching
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

var _ = strconv.Itoa
var _ = fmt.Sprintf
