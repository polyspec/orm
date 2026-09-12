// Package planner turns a validated IR request into a Plan.
//
// one/all/count/group_count/sum/avg/paginate over a root entity with nested joins;
// relations as separate IN steps bound to the parent step's rows (nested to
// any depth, hanging off the root or a join); insert/update/delete.
package planner

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/polyspec/orm/engine/dialect"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/engine/schema"
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
	extra  []string // columns a relation step needs selected (its match column, key_by)
}

// relCtx describes the relation a step loads: which parent step/column feeds
// its IN list and how the rows attach.
type relCtx struct {
	parentStep int
	parentAsm  *plan.Assemble
	parentKeys []string
	childKeys  []string
	kind       string
}

// stepSet numbers steps in build order, so a parent always precedes its relation steps.
type stepSet struct{ steps []*plan.Step }

func (ps *stepSet) add(st *plan.Step) int {
	st.ID = len(ps.steps)
	ps.steps = append(ps.steps, st)
	return st.ID
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

func (b *builder) config(name string) string {
	b.binds = append(b.binds, plan.BindSlot{From: "config", Name: name})
	b.n++
	return b.p.D.Placeholder(b.n)
}

// now is a timestamp the executor supplies (dialects without a sub-second clock function).
func (b *builder) now() string {
	b.binds = append(b.binds, plan.BindSlot{From: "now"})
	b.n++
	return b.p.D.Placeholder(b.n)
}

// fillPlaceholders replaces each `?` of a user fragment with the dialect's
// placeholder for the next bind (PostgreSQL needs $n); the count must match.
func (p *Planner) fillPlaceholders(b *builder, frag string, ps []int) (string, error) {
	if n := strings.Count(frag, "?"); n != len(ps) {
		return "", &ir.Error{Code: "IR_INVALID", Msg: fmt.Sprintf("fragment has %d placeholders but %d binds", n, len(ps))}
	}
	var sb strings.Builder
	k := 0
	for i := 0; i < len(frag); i++ {
		if frag[i] == '?' {
			sb.WriteString(b.param(ps[k]))
			k++
			continue
		}
		sb.WriteByte(frag[i])
	}
	return sb.String(), nil
}

// parentList is the one placeholder an executor expands to the parent values.
func (b *builder) parentList(step int) string {
	b.binds = append(b.binds, plan.BindSlot{From: "parent", Step: step})
	b.n++
	return b.p.D.Placeholder(b.n)
}

func (p *Planner) Compile(r *ir.Request) (*plan.Plan, error) {
	out := &plan.Plan{SchemaHash: p.M.SchemaHash, Kind: r.Kind}
	ps := &stepSet{}
	var err error
	switch r.Kind {
	case "one", "all", "count", "group_count", "count_distinct", "sum", "avg", "min", "max":
		_, err = p.selectStep(ps, &r.Query, r.Kind, r.Agg, nil)
	case "paginate":
		// main (+ its relation steps), then the count step: executors find it by role.
		if _, err = p.selectStep(ps, &r.Query, "all", "", nil); err == nil {
			_, err = p.selectStep(ps, &r.Query, "count", "", nil)
		}
	case "insert":
		var st *plan.Step
		if st, err = p.insertStep(r); err == nil {
			ps.add(st)
		}
	case "update":
		var st *plan.Step
		if st, err = p.updateStep(r); err == nil {
			ps.add(st)
		}
	case "delete":
		var st *plan.Step
		if st, err = p.deleteStep(r); err == nil {
			ps.add(st)
		}
	case "raw":
		b := &builder{p: p}
		ent := p.M.Entities[r.Entity]
		sql, err2 := p.fillPlaceholders(b, strings.ReplaceAll(r.Raw.SQL, "{table}", p.D.Quote(ent.Table)), r.Raw.Ps)
		if err2 != nil {
			err = err2
			break
		}
		ps.add(&plan.Step{Role: "raw", SQL: sql, BindSlots: b.binds})
	}
	if err != nil {
		return nil, err
	}
	for _, st := range ps.steps {
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

// selectStep builds one SELECT statement for q. rc is nil for the root
// statement; for a relation step it names the parent and the match column,
// and the step's own relations are built (recursively) right after it.
func (p *Planner) selectStep(ps *stepSet, q *ir.Query, kind, agg string, rc *relCtx) (*plan.Step, error) {
	b := &builder{p: p}
	root := p.buildScopes(q, "a", nil)
	if rc != nil {
		root.extra = append(root.extra, rc.childKeys...)
		if q.KeyBy != "" {
			root.extra = append(root.extra, q.KeyBy)
		}
	}
	var sb strings.Builder
	sb.WriteString("SELECT ")
	if q.Distinct && kind != "count" && kind != "group_count" {
		sb.WriteString("DISTINCT ")
	}
	asm := &plan.Assemble{Entity: root.ent.Name, Alias: root.alias}
	var outNames []string
	idx := 0
	groupCount := kind == "count" && (len(q.GroupBy) > 0 || len(q.GroupByExpr) > 0) // number of groups: wrap the grouped statement
	distinctRootCount := kind == "count" && q.Distinct && len(root.ent.PK) > 1
	groupRows := kind == "group_count"
	switch kind {
	case "count":
		if groupCount {
			sb.WriteString("1")
		} else if distinctRootCount {
			sb.WriteString("DISTINCT ")
			for i, key := range root.ent.PK {
				if i > 0 {
					sb.WriteString(", ")
				}
				sb.WriteString(p.qcol(root, key))
			}
		} else if q.Distinct {
			sb.WriteString("COUNT(DISTINCT " + p.qcol(root, root.ent.PK[0]) + ")")
		} else {
			sb.WriteString("COUNT(*)")
		}
	case "count_distinct":
		sb.WriteString("COUNT(DISTINCT " + p.qcol(root, agg) + ")")
	case "sum":
		sb.WriteString("COALESCE(SUM(" + p.qcol(root, agg) + "), 0)")
	case "avg":
		sb.WriteString("AVG(" + p.qcol(root, agg) + ")")
	case "min":
		sb.WriteString("MIN(" + p.qcol(root, agg) + ")")
	case "max":
		sb.WriteString("MAX(" + p.qcol(root, agg) + ")")
	case "group_count":
		if err := p.selectGroupCountList(b, &sb, root, asm, &idx, &outNames); err != nil {
			return nil, err
		}
	default:
		if err := p.selectList(b, &sb, root, asm, &idx, &outNames); err != nil {
			return nil, err
		}
	}
	// Rows per parent: ROW_NUMBER() over the match column. A one-relation with an
	// ORDER is the same thing with n = 1 (the first row by that order wins).
	perParent := 0
	if rc != nil {
		perParent = q.LimitPerParent
		if perParent == 0 && rc.kind == "one" && len(q.Order) > 0 {
			perParent = 1
		}
	}
	if perParent > 0 {
		order, err := p.renderOrder(root, q)
		if err != nil {
			return nil, err
		}
		if order == "" {
			order = " ORDER BY " + p.qcol(root, root.ent.PK[0]) + " ASC"
		}
		parts := p.qualified(root, rc.childKeys)
		sb.WriteString(", ROW_NUMBER() OVER (PARTITION BY " + strings.Join(parts, ", ") + order + ") AS " + p.D.Quote("orm_rn"))
	}
	sb.WriteString(" FROM " + p.D.Quote(root.ent.Table) + " AS " + p.D.Quote(root.alias))
	if q.ForceIdx != "" {
		sb.WriteString(p.D.ForceIndex(q.ForceIdx))
	}
	if err := p.renderJoins(b, &sb, root); err != nil {
		return nil, err
	}
	// WHERE = [parent IN list] AND root group AND each join's where group (declaration order).
	var where []string
	if rc != nil {
		if len(rc.childKeys) == 1 {
			where = append(where, p.qcol(root, rc.childKeys[0])+" IN ("+b.parentList(rc.parentStep)+")")
		} else {
			where = append(where, "("+strings.Join(p.qualified(root, rc.childKeys), ", ")+") IN (("+b.parentList(rc.parentStep)+"))")
		}
	}
	if q.ScopeP != nil {
		clause, err := p.scopeClause(b, root)
		if err != nil {
			return nil, err
		}
		where = append(where, clause)
	}
	if q.Where != nil && len(q.Where.Items) > 0 {
		s, err := p.renderGroup(b, root, q.Where, rc == nil && q.ScopeP == nil)
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
	// GROUP BY applies to row selects and to the group count; scalar aggregates ignore it.
	if (len(q.GroupBy) > 0 || len(q.GroupByExpr) > 0) && (kind == "one" || kind == "all" || groupCount || groupRows) {
		sb.WriteString(" GROUP BY ")
		group, err := p.renderGroupBy(root, q)
		if err != nil {
			return nil, err
		}
		sb.WriteString(group)
		if q.Having != nil && len(q.Having.Items) > 0 {
			h, err := p.renderGroup(b, root, q.Having, true)
			if err != nil {
				return nil, err
			}
			sb.WriteString(" HAVING " + h)
		}
	}
	if groupCount || distinctRootCount {
		wrapped := "SELECT COUNT(*) FROM (" + sb.String() + ") AS " + p.D.Quote("orm_g")
		sb.Reset()
		sb.WriteString(wrapped)
	}
	if kind == "one" || kind == "all" || kind == "group_count" {
		if perParent > 0 {
			// wrap: keep the output columns (same order), drop orm_rn, cut at n per parent
			var outer strings.Builder
			outer.WriteString("SELECT ")
			for i, n := range outNames {
				if i > 0 {
					outer.WriteString(", ")
				}
				outer.WriteString(p.D.Quote("orm_w") + "." + p.D.Quote(n))
			}
			outer.WriteString(" FROM (" + sb.String() + ") AS " + p.D.Quote("orm_w") + " WHERE " + p.D.Quote("orm_w") + "." + p.D.Quote("orm_rn") + " <= " + strconv.Itoa(perParent))
			outer.WriteString(" ORDER BY ")
			for i, key := range rc.childKeys {
				if i > 0 {
					outer.WriteString(", ")
				}
				outer.WriteString(p.D.Quote("orm_w") + "." + p.D.Quote(root.alias+"__"+key))
			}
			outer.WriteString(", " + p.D.Quote("orm_w") + "." + p.D.Quote("orm_rn"))
			sb = outer
		} else {
			order, err := p.renderOrder(root, q)
			if err != nil {
				return nil, err
			}
			sb.WriteString(order)
			switch {
			case kind == "one" && rc == nil:
				sb.WriteString(p.D.Limit(0, 1))
			case q.Limit != nil:
				sb.WriteString(p.D.Limit(q.Limit.Offset, q.Limit.Count))
			}
		}
	}
	st := &plan.Step{Role: "main", SQL: sb.String(), BindSlots: b.binds}
	switch {
	case kind == "count" && len(ps.steps) > 0:
		st.Role = "count"
	case rc != nil:
		st.Role = "relation"
		st.Parent = &plan.ParentRef{Step: rc.parentStep, Keys: keyRefs(rc.parentAsm, rc.parentKeys)}
		if q.IfParent != nil {
			st.Parent.IfParent = &plan.IfParent{Column: q.IfParent.Column, Index: indexOf(rc.parentAsm, q.IfParent.Column), Param: q.IfParent.P}
		}
		if q.DropChildKey {
			for _, key := range rc.childKeys {
				asm.Columns[indexOf(asm, key)].Hidden = true
			}
		}
	}
	if kind == "one" || kind == "all" || kind == "group_count" {
		st.Assemble = asm
	}
	id := ps.add(st)
	if st.Assemble != nil {
		if err := p.relationSteps(ps, root, asm, id); err != nil {
			return nil, err
		}
	}
	return st, nil
}

// relationSteps builds a step per relation declared on s (and on its joins,
// recursively) and records how its rows attach in asm.Children.
func (p *Planner) relationSteps(ps *stepSet, s *scope, asm *plan.Assemble, stepID int) error {
	for _, r := range s.q.Relations {
		rel := s.ent.Relations[r.Rel]
		parentKeys, childKeys := relationColumns(rel)
		rc := &relCtx{parentStep: stepID, parentAsm: asm, parentKeys: parentKeys, childKeys: childKeys, kind: rel.Kind}
		st, err := p.selectStep(ps, r.Query, "all", "", rc)
		if err != nil {
			return err
		}
		target := p.M.Entities[rel.Target]
		ch := &plan.Child{
			Rel: r.Rel, Kind: rel.Kind, Step: st.ID,
			ParentKeys: keyRefs(asm, parentKeys),
			ChildKeys:  keyRefs(st.Assemble, childKeys),
			Flatten:    r.Query.Flatten,
			// owned when the target holds the FK (this row's PK on the left, a non-PK column on the right)
			Cascade: !r.Query.NoCascadeDelete && slices.Equal(parentKeys, s.ent.PK) && !slices.Equal(childKeys, target.PK),
		}
		if r.Query.KeyBy != "" {
			ch.Key = keyRefs(st.Assemble, []string{r.Query.KeyBy})
		} else {
			ch.Key = keyRefs(st.Assemble, p.M.Entities[st.Assemble.Entity].PK)
		}
		asm.Children = append(asm.Children, ch)
	}
	for _, j := range s.q.Joins {
		js := s.joins[j.Rel]
		for _, ch := range asm.Children {
			if ch.Kind == "join" && ch.Rel == j.Rel {
				if err := p.relationSteps(ps, js, ch.Assemble, stepID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// indexOf returns the positional index of a column in an assemble node. The
// planner guarantees presence (PK first, relation columns via scope.extra).
func indexOf(a *plan.Assemble, name string) int {
	for _, c := range a.Columns {
		if c.Name == name {
			return c.Index
		}
	}
	panic("planner: column " + name + " not projected in " + a.Entity)
}

func keyRefs(a *plan.Assemble, columns []string) []plan.KeyRef {
	out := make([]plan.KeyRef, len(columns))
	for i, column := range columns {
		out[i] = plan.KeyRef{Column: column, Index: indexOf(a, column)}
	}
	return out
}

func relationColumns(rel *schema.Rel) ([]string, []string) {
	local := make([]string, len(rel.Keys))
	target := make([]string, len(rel.Keys))
	for i, key := range rel.Keys {
		local[i], target[i] = key.Local, key.Target
	}
	return local, target
}

func (p *Planner) qualified(scope *scope, columns []string) []string {
	out := make([]string, len(columns))
	for i, column := range columns {
		out[i] = p.qcol(scope, column)
	}
	return out
}

func (p *Planner) renderOrder(root *scope, q *ir.Query) (string, error) {
	if len(q.Order) == 0 {
		return "", nil
	}
	var sb strings.Builder
	sb.WriteString(" ORDER BY ")
	for i, o := range q.Order {
		if i > 0 {
			sb.WriteString(", ")
		}
		if o.Expr != "" {
			s, err := p.renderExpr(root, o.Expr)
			if err != nil {
				return "", err
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
	return sb.String(), nil
}

func (p *Planner) renderGroupBy(root *scope, q *ir.Query) (string, error) {
	parts := make([]string, 0, len(q.GroupBy)+len(q.GroupByExpr))
	for _, name := range q.GroupBy {
		parts = append(parts, p.qcol(root, name))
	}
	for _, g := range q.GroupByExpr {
		expr, err := p.renderExpr(root, g.Expr)
		if err != nil {
			return "", err
		}
		parts = append(parts, expr)
	}
	return strings.Join(parts, ", "), nil
}

// selectGroupCountList writes the grouped columns and row_count projection for
// the grouped-count result shape. The result is still assembled as the root entity
// so each language can expose the grouped columns through its normal row API.
func (p *Planner) selectGroupCountList(b *builder, sb *strings.Builder, s *scope, asm *plan.Assemble, idx *int, outNames *[]string) error {
	for _, name := range s.q.GroupBy {
		col := s.ent.Column(name)
		if col == nil {
			return &ir.Error{Code: "COLUMN_UNKNOWN", Msg: s.ent.Name + "." + name}
		}
		if *idx > 0 {
			sb.WriteString(", ")
		}
		expr, _ := p.D.ReadExpr(p.qcol(s, name), col.Type, p.sqlStyles(col.Styles), func() string { return b.secret("aes") })
		out := s.alias + "__" + name
		sb.WriteString(expr + " AS " + p.D.Quote(out))
		*outNames = append(*outNames, out)
		asm.Columns = append(asm.Columns, plan.OutCol{Index: *idx, Name: name, Column: name, Type: col.Type, Styles: p.appStyles(col.Styles)})
		*idx++
	}
	for _, g := range s.q.GroupByExpr {
		if *idx > 0 {
			sb.WriteString(", ")
		}
		expr, err := p.renderExpr(s, g.Expr)
		if err != nil {
			return err
		}
		out := s.alias + "__" + g.As
		sb.WriteString(expr + " AS " + p.D.Quote(out))
		*outNames = append(*outNames, out)
		typ := "string"
		if col := s.ent.Column(g.As); col != nil {
			typ = col.Type
		}
		asm.Columns = append(asm.Columns, plan.OutCol{Index: *idx, Name: g.As, Type: typ})
		*idx++
	}
	if *idx > 0 {
		sb.WriteString(", ")
	}
	out := s.alias + "__row_count"
	sb.WriteString("COUNT(*) AS " + p.D.Quote(out))
	*outNames = append(*outNames, out)
	asm.Columns = append(asm.Columns, plan.OutCol{Index: *idx, Name: "row_count", Type: "i64"})
	*idx++
	return nil
}

// selectList writes the projection for a scope and its joins, recording the
// positional mapping in asm. Join columns become Child{kind: join}.
func (p *Planner) selectList(b *builder, sb *strings.Builder, s *scope, asm *plan.Assemble, idx *int, outNames *[]string) error {
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
			e, _ := p.D.ReadExpr(p.qcol(s, c.column), col.Type, p.sqlStyles(col.Styles), func() string { return b.secret("aes") })
			expr = e
			styles = p.appStyles(col.Styles)
		}
		sb.WriteString(expr + " AS " + p.D.Quote(s.alias+"__"+c.name))
		*outNames = append(*outNames, s.alias+"__"+c.name)
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
		if err := p.selectList(b, sb, js, child.Assemble, idx, outNames); err != nil {
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
	// Columns relation steps bind or key on are always selected (hidden ones
	// are marked by the relation step itself).
	for _, x := range s.extra {
		if !contains(base, x) {
			base = append(base, x)
		}
	}
	for _, r := range s.q.Relations {
		rel := s.ent.Relations[r.Rel]
		for _, key := range rel.Keys {
			if !contains(base, key.Local) {
				base = append(base, key.Local)
			}
		}
		if r.Query.IfParent != nil && !contains(base, r.Query.IfParent.Column) {
			base = append(base, r.Query.IfParent.Column)
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
		conditions := make([]string, len(rel.Keys))
		for i, key := range rel.Keys {
			conditions[i] = p.qcol(s, key.Local) + " = " + p.qcol(js, key.Target)
		}
		sb.WriteString(kw + p.D.Quote(js.ent.Table) + " AS " + p.D.Quote(js.alias) + " ON " + strings.Join(conditions, " AND "))
		if j.Query.ScopeP != nil {
			scope, err := p.scopeClause(b, js)
			if err != nil {
				return err
			}
			sb.WriteString(" AND " + scope)
		}
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

func (p *Planner) scopeClause(b *builder, s *scope) (string, error) {
	if s.q.ScopeP == nil {
		return "", nil
	}
	col := s.ent.Column(s.ent.Scope)
	value, err := p.renderValue(b, col, *s.q.ScopeP)
	if err != nil {
		return "", err
	}
	return p.qcol(s, s.ent.Scope) + " = " + value, nil
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
	if pr.Op != "" && !p.D.Supports(pr.Op) {
		return "", &ir.Error{Code: "OPERATOR_NOT_ALLOWED", Msg: pr.Op + " is not available on " + p.D.Name()}
	}
	if pr.Expr != "" {
		e, err := p.renderExpr(s, pr.Expr)
		if err != nil {
			return "", err
		}
		e, err = p.fillPlaceholders(b, e, pr.Ps)
		if err != nil {
			return "", err
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
// equality predicates on encrypted columns keep working.
func (p *Planner) renderValue(b *builder, col *schema.Col, i int) (string, error) {
	styles := p.sqlStyles(col.Styles)
	// SQL-side stages the dialect lacks (aes/hex/ip on PostgreSQL/SQLite) are
	// applied by the executor to the bound value: recorded on the slot.
	var host []string
	for _, st := range col.Styles {
		if (st == "aes" || st == "hex" || st == "ip") && !p.D.HandlesStyle(st) {
			host = append(host, st)
		}
	}
	if len(styles) == 0 && col.Type != "point" {
		ph := b.param(i)
		b.binds[len(b.binds)-1].HostStyles = host
		b.binds[len(b.binds)-1].ColType = bindType(col)
		return ph, nil
	}
	first := true
	e, _ := p.D.WriteExpr(func() string {
		if first {
			first = false
			ph := b.param(i)
			b.binds[len(b.binds)-1].HostStyles = host
			b.binds[len(b.binds)-1].ColType = bindType(col)
			return ph
		}
		return b.secret("aes")
	}, col.Type, styles)
	return e, nil
}

// bindType names types that executors must normalize before driver binding.
func bindType(col *schema.Col) string {
	if col == nil {
		return ""
	}
	switch col.Type {
	case "date", "time", "datetime", "point":
		return col.Type
	}
	return ""
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
	set := slices.Clone(r.Set)
	if err := validateAESAssignments(ent, set, false); err != nil {
		return nil, err
	}
	if r.ScopeP != nil && !assigned(set, ent.Scope) {
		set = append(set, ir.Assign{Column: ent.Scope, P: r.ScopeP})
	}
	var cols, vals []string
	for _, a := range set {
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
	if version := aesVersionColumn(ent); version != "" && !assigned(set, version) {
		cols = append(cols, p.D.Quote(version))
		vals = append(vals, b.config("aes_version"))
	}
	sql := "INSERT INTO " + p.D.Quote(ent.Table) + " (" + strings.Join(cols, ", ") + ") VALUES (" + strings.Join(vals, ", ") + ")"
	if len(r.OnDuplicate) > 0 {
		if err := validateAESAssignments(ent, r.OnDuplicate, true); err != nil {
			return nil, err
		}
		var sets []string
		for _, a := range r.OnDuplicate {
			v, err := p.renderAssign(b, ent, ent.Column(a.Column), &a)
			if err != nil {
				return nil, err
			}
			sets = append(sets, p.D.Quote(a.Column)+" = "+v)
		}
		if version := aesVersionColumn(ent); version != "" && assignsAES(ent, r.OnDuplicate) && !assigned(r.OnDuplicate, version) {
			sets = append(sets, p.D.Quote(version)+" = "+b.config("aes_version"))
		}
		if ent.Auto != "" && !p.D.InsertReturningID() {
			// MySQL idiom: make last insert id report the existing row on update
			sets = append(sets, p.D.Quote(ent.Auto)+" = LAST_INSERT_ID("+p.D.Quote(ent.Auto)+")")
		}
		sql += p.D.Upsert(conflictTarget(ent, set), strings.Join(sets, ", "))
	}
	if p.D.InsertReturningID() && ent.Auto != "" {
		sql += " RETURNING " + p.D.Quote(ent.Auto)
	}
	return &plan.Step{Role: "main", SQL: sql, BindSlots: b.binds}, nil
}

func aesVersionColumn(ent *schema.Entity) string {
	for _, col := range ent.Columns {
		if len(col.Styles) > 0 && col.Styles[0] == "aes" {
			return "aes_key_version"
		}
	}
	return ""
}

func assignsAES(ent *schema.Entity, set []ir.Assign) bool {
	for _, assign := range set {
		if col := ent.Column(assign.Column); col != nil && len(col.Styles) > 0 && col.Styles[0] == "aes" {
			return true
		}
	}
	return false
}

// validateAESAssignments preserves the row-level key-version invariant. The
// version is managed by the planner. An update that changes encrypted data
// must replace every AES column because one version describes the whole row.
func validateAESAssignments(ent *schema.Entity, set []ir.Assign, requireComplete bool) error {
	version := aesVersionColumn(ent)
	if version == "" {
		return nil
	}
	if assigned(set, version) {
		return &ir.Error{Code: "IR_INVALID", Msg: version + " is managed by the AES writer"}
	}
	if !requireComplete || !assignsAES(ent, set) {
		return nil
	}
	for _, col := range ent.Columns {
		if len(col.Styles) > 0 && col.Styles[0] == "aes" && !assigned(set, col.Name) {
			return &ir.Error{Code: "IR_INVALID", Msg: "AES update must assign every AES column; missing " + col.Name}
		}
	}
	return nil
}

func assigned(set []ir.Assign, col string) bool {
	for _, a := range set {
		if a.Column == col {
			return true
		}
	}
	return false
}

// conflictTarget picks the unique key an upsert conflicts on for dialects that
// need one named (ON CONFLICT): the first declared unique key whose columns are
// all being inserted, else the primary key.
func conflictTarget(ent *schema.Entity, set []ir.Assign) []string {
	inserted := map[string]bool{}
	for _, a := range set {
		inserted[a.Column] = true
	}
	for _, uk := range ent.Unique {
		all := true
		for _, c := range uk {
			if !inserted[c] {
				all = false
			}
		}
		if all {
			return uk
		}
	}
	return ent.PK
}

func (p *Planner) renderAssign(b *builder, ent *schema.Entity, col *schema.Col, a *ir.Assign) (string, error) {
	switch {
	case a.Expr != "":
		e, err := p.renderExpr(&scope{ent: ent, alias: ent.Table}, a.Expr)
		if err != nil {
			return "", err
		}
		return p.fillPlaceholders(b, e, a.Ps)
	case a.PlusP != nil:
		// the reference is table-qualified: inside ON CONFLICT DO UPDATE a bare name is ambiguous
		return p.D.Quote(ent.Table) + "." + p.D.Quote(col.Name) + " + " + b.param(*a.PlusP), nil
	case a.MinusP != nil:
		// clamp at zero
		q := p.D.Quote(ent.Table) + "." + p.D.Quote(col.Name)
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
	if err := validateAESAssignments(ent, r.Set, true); err != nil {
		return nil, err
	}
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
	if version := aesVersionColumn(ent); version != "" && assignsAES(ent, r.Set) && !assigned(r.Set, version) {
		sets = append(sets, p.D.Quote(version)+" = "+b.config("aes_version"))
	}
	// The updated timestamp is always assigned explicitly: MySQL's ON UPDATE
	// clause has no counterpart on the other dialects, and optimistic locking
	// (updated_ts as the version) needs identical behaviour everywhere.
	if ts := ent.Timestamps; ts != nil && ts.Updated != "" && !assigned(r.Set, ts.Updated) {
		if col := ent.Column(ts.Updated); col != nil {
			now := p.D.Now()
			switch {
			case p.D.HostNow():
				now = b.now() // no sub-second clock in SQL: the executor binds its own microsecond timestamp
			case col.Precision > 0 && p.D.Name() == "mysql":
				now = fmt.Sprintf("CURRENT_TIMESTAMP(%d)", col.Precision)
			}
			sets = append(sets, p.D.Quote(ts.Updated)+" = "+now)
		}
	}
	where, err := p.renderGroup(b, root, r.Where, r.ScopeP == nil)
	if err != nil {
		return nil, err
	}
	if r.Optimistic != nil {
		where += " AND " + p.qcol(root, r.Optimistic.Column) + " = " + b.param(r.Optimistic.P)
	}
	if r.ScopeP != nil {
		scope, e := p.scopeClause(b, root)
		if e != nil {
			return nil, e
		}
		where = scope + " AND " + where
	}
	sql := "UPDATE " + p.D.Quote(ent.Table) + " SET " + strings.Join(sets, ", ") + " WHERE " + where
	return &plan.Step{Role: "main", SQL: sql, BindSlots: b.binds}, nil
}

func (p *Planner) deleteStep(r *ir.Request) (*plan.Step, error) {
	b := &builder{p: p}
	ent := p.M.Entities[r.Entity]
	root := p.buildScopes(&r.Query, ent.Table, nil)
	where, err := p.renderGroup(b, root, r.Where, r.ScopeP == nil)
	if err != nil {
		return nil, err
	}
	if r.ScopeP != nil {
		scope, e := p.scopeClause(b, root)
		if e != nil {
			return nil, e
		}
		where = scope + " AND " + where
	}
	sql := "DELETE FROM " + p.D.Quote(ent.Table) + " WHERE " + where
	return &plan.Step{Role: "main", SQL: sql, BindSlots: b.binds}, nil
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

// sqlStyles keeps only the stages the dialect applies in SQL; appStyles the
// rest, in write order, for the executor (docs/codec.md).
func (p *Planner) sqlStyles(styles []string) []string {
	var out []string
	for _, s := range styles {
		if p.D.HandlesStyle(s) {
			out = append(out, s)
		}
	}
	return out
}

func (p *Planner) appStyles(styles []string) []string {
	var out []string
	for _, s := range styles {
		if !p.D.HandlesStyle(s) {
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

var _ = fmt.Sprintf
