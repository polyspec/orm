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
	"github.com/polyspec/orm/engine/runtimemodel"
)

type Planner struct {
	M *runtimemodel.Model
	D dialect.Dialect
}

// scope is one entity occurrence in a statement (root or a join) with its alias.
type scope struct {
	ent    *runtimemodel.Entity
	alias  string
	q      *ir.Query
	joins  map[string]*scope
	parent *scope
	outer  *scope   // enclosing query of a subquery root ("^" refs)
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
	p      *Planner
	binds  []plan.BindSlot
	n      int
	subs   int             // subquery alias counter
	tables map[string]bool // statement이 이름으로 쓴 table
	// err는 type 없는 slot처럼 placeholder를 만들며 생긴 첫 planner 오류다.
	// statement를 만드는 곳이 step을 돌려주기 전에 확인한다.
	err error
}

// table은 ent의 table 이름을 quote하고 statement의 table로 기록한다.
func (b *builder) table(ent *runtimemodel.Entity) string {
	if b.tables == nil {
		b.tables = map[string]bool{}
	}
	b.tables[ent.Table] = true
	return b.p.D.Quote(ent.Table)
}

// tableList는 statement가 쓴 table을 정렬해 돌려준다.
func (b *builder) tableList() []string {
	out := make([]string, 0, len(b.tables))
	for t := range b.tables {
		out = append(out, t)
	}
	slices.Sort(out)
	return out
}

// slot은 bind slot 하나를 더하고 그 placeholder를 돌려준다. type 없는 slot은
// planner 오류다.
func (b *builder) slot(s plan.BindSlot) string {
	if s.ColType == "" && b.err == nil {
		b.err = &ir.Error{Code: "IR_INVALID", Msg: fmt.Sprintf("bind slot %d (%s) has no declared type", len(b.binds), s.From)}
	}
	b.binds = append(b.binds, s)
	b.n++
	return b.p.D.Placeholder(b.n)
}

// param은 request 값 Params[i]의 placeholder다. typ은 그 값의 dbspec type이다.
func (b *builder) param(i int, typ string) string {
	return b.slot(plan.BindSlot{From: "param", Param: i, ColType: typ})
}

// colParam은 column col과 비교하거나 col에 할당하는 값 Params[i]의
// placeholder다. type은 col의 type이고 decimal은 그 자릿수를 싣는다.
func (b *builder) colParam(i int, col *runtimemodel.Field, transform string) string {
	s := plan.BindSlot{From: "param", Param: i, Transform: transform, ColType: col.Type}
	if col.Type == "decimal" {
		s.Precision, s.Scale = col.Precision, col.Scale
	}
	return b.slot(s)
}

// secret은 executor 설정의 key다. key는 text다.
func (b *builder) secret(name string) string {
	return b.slot(plan.BindSlot{From: "secret", Name: name, ColType: "text"})
}

// config는 executor 설정 값이다. typ은 그 값을 쓰는 column의 type이다.
func (b *builder) config(name, typ string) string {
	return b.slot(plan.BindSlot{From: "config", Name: name, ColType: typ})
}

// now은 sub-second clock 함수가 없는 dialect에서 executor가 주는 시각이다.
// precision은 그 시각이 들어가는 datetime column의 소수 자리다.
func (b *builder) now(precision int) string {
	return b.slot(plan.BindSlot{From: "now", Precision: precision, ColType: "datetime"})
}

// audit은 executor가 채우는 transaction의 audit 기록 key다. Name은 audit 기록
// table이며, executor는 transaction의 audit이 그 table의 행인지 확인한다. type은
// audit column의 type이다.
func (b *builder) audit(ent *runtimemodel.Entity) string {
	return b.slot(plan.BindSlot{From: "audit", Name: ent.Audit.Record, ColType: ent.Field(ent.Audit.Column).Type})
}

// parentList is the one placeholder an executor expands to the parent values.
// keyTypes are the dbspec types of the compared key columns, in key order.
func (b *builder) parentList(step int, keyTypes []string) string {
	b.binds = append(b.binds, plan.BindSlot{From: "parent", Step: step, KeyTypes: keyTypes})
	b.n++
	return b.p.D.Placeholder(b.n)
}

func (p *Planner) Compile(r *ir.Request) (*plan.Plan, error) {
	out := &plan.Plan{ManifestHash: p.M.ManifestHash, Kind: r.Kind}
	ps := &stepSet{}
	var err error
	switch r.Kind {
	case "one", "all", "count", "group_count", "sum", "avg":
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
	case "restore":
		var st *plan.Step
		if st, err = p.restoreStep(r); err == nil {
			ps.add(st)
		}
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
	asm := &plan.Assemble{Entity: root.ent.Name, Alias: root.alias}
	var outNames []string
	idx := 0
	groupCount := kind == "count" && len(q.GroupBy) > 0 // number of groups: wrap the grouped statement
	groupRows := kind == "group_count"
	switch kind {
	case "count":
		if groupCount {
			sb.WriteString("1")
		} else {
			sb.WriteString("COUNT(*)")
		}
	case "sum":
		sb.WriteString("COALESCE(SUM(" + p.qcol(root, agg) + "), 0)")
	case "avg":
		sb.WriteString("AVG(" + p.qcol(root, agg) + ")")
	case "group_count":
		if err := p.selectGroupCountList(b, &sb, root, asm, &idx, &outNames); err != nil {
			return nil, err
		}
		asm.Key = keyRefs(asm, append([]string(nil), q.GroupBy...))
	default:
		if err := p.selectList(b, &sb, root, asm, &idx, &outNames); err != nil {
			return nil, err
		}
		asm.Key = keyRefs(asm, root.ent.PK)
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
		order, err := p.renderOrder(b, root, q)
		if err != nil {
			return nil, err
		}
		if order == "" {
			order = " ORDER BY " + p.qcol(root, root.ent.PK[0]) + " ASC"
		}
		parts := p.qualified(root, rc.childKeys)
		sb.WriteString(", ROW_NUMBER() OVER (PARTITION BY " + strings.Join(parts, ", ") + order + ") AS " + p.D.Quote("orm_rn"))
	}
	sb.WriteString(" FROM " + b.table(root.ent) + " AS " + p.D.Quote(root.alias))
	if q.ForceIdx != "" {
		sb.WriteString(p.D.ForceIndex(q.ForceIdx))
	}
	if err := p.renderJoins(b, &sb, root); err != nil {
		return nil, err
	}
	// WHERE = [parent IN list] AND root group AND each join's where group (declaration order).
	var where []string
	if rc != nil {
		keyTypes := make([]string, len(rc.childKeys))
		for i, key := range rc.childKeys {
			keyTypes[i] = root.ent.Field(key).Type
		}
		if len(rc.childKeys) == 1 {
			where = append(where, p.qcol(root, rc.childKeys[0])+" IN ("+b.parentList(rc.parentStep, keyTypes)+")")
		} else {
			where = append(where, "("+strings.Join(p.qualified(root, rc.childKeys), ", ")+") IN (("+b.parentList(rc.parentStep, keyTypes)+"))")
		}
	}
	if root.ent.SoftDelete != "" {
		where = append(where, p.qcol(root, root.ent.SoftDelete)+" IS NULL")
	}
	if q.Where != nil && len(q.Where.Items) > 0 {
		s, err := p.renderGroup(b, root, q.Where, rc == nil)
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
	if len(q.GroupBy) > 0 && (kind == "one" || kind == "all" || groupCount || groupRows) {
		sb.WriteString(" GROUP BY " + p.renderGroupBy(root, q))
	}
	if groupCount {
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
			order, err := p.renderOrder(b, root, q)
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
			if q.Lock != "" {
				lock, ok := p.D.RowLock(q.Lock)
				if !ok {
					return nil, &ir.Error{Code: "CAPABILITY_UNSUPPORTED", Msg: fmt.Sprintf("%s row lock %q is not supported", p.D.Name(), q.Lock)}
				}
				sb.WriteString(lock)
			}
		}
	}
	if b.err != nil {
		return nil, b.err
	}
	st := &plan.Step{Role: "main", SQL: sb.String(), Tables: b.tableList(), Lock: q.Lock, BindSlots: b.binds}
	switch {
	case kind == "count" && len(ps.steps) > 0:
		st.Role = "count"
	case rc != nil:
		st.Role = "relation"
		st.Parent = &plan.ParentRef{Step: rc.parentStep, Keys: keyRefs(rc.parentAsm, rc.parentKeys)}
		if q.IfParent != nil {
			st.Parent.IfParent = &plan.IfParent{Column: q.IfParent.Column, Index: indexOf(rc.parentAsm, q.IfParent.Column), Param: q.IfParent.P}
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
		rc := &relCtx{parentStep: stepID, parentAsm: asm}
		for _, k := range r.Keys {
			rc.parentKeys = append(rc.parentKeys, k.Left)
			rc.childKeys = append(rc.childKeys, k.Right)
		}
		rc.kind = r.Kind
		target := p.M.Entities[r.Query.Entity]
		parentKeys, childKeys := rc.parentKeys, rc.childKeys
		st, err := p.selectStep(ps, r.Query, "all", "", rc)
		if err != nil {
			return err
		}
		ch := &plan.Child{
			Rel: r.Rel, Kind: rc.kind, Step: st.ID,
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

func (p *Planner) qualified(scope *scope, columns []string) []string {
	out := make([]string, len(columns))
	for i, column := range columns {
		out[i] = p.qcol(scope, column)
	}
	return out
}

func (p *Planner) renderOrder(b *builder, root *scope, q *ir.Query) (string, error) {
	if len(q.Order) == 0 {
		return "", nil
	}
	var sb strings.Builder
	sb.WriteString(" ORDER BY ")
	for i, o := range q.Order {
		if i > 0 {
			sb.WriteString(", ")
		}
		switch {
		case o.Random:
			sb.WriteString(p.D.Random())
			continue
		case o.Fn != nil:
			s, err := p.columnFunction(b, root, o.Column, o.Fn)
			if err != nil {
				return "", err
			}
			sb.WriteString(s)
		default:
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

func (p *Planner) renderGroupBy(root *scope, q *ir.Query) string {
	parts := make([]string, 0, len(q.GroupBy))
	for _, name := range q.GroupBy {
		parts = append(parts, p.qcol(root, name))
	}
	return strings.Join(parts, ", ")
}

// selectGroupCountList writes the grouped columns and row_count projection for
// the grouped-count result shape. The result is still assembled as the root entity
// so each language can expose the grouped columns through its normal row API.
func (p *Planner) selectGroupCountList(b *builder, sb *strings.Builder, s *scope, asm *plan.Assemble, idx *int, outNames *[]string) error {
	for _, name := range s.q.GroupBy {
		col := s.ent.Field(name)
		if col == nil {
			return &ir.Error{Code: "COLUMN_UNKNOWN", Msg: s.ent.Name + "." + name}
		}
		if *idx > 0 {
			sb.WriteString(", ")
		}
		expr, _ := p.D.ReadExpr(p.qcol(s, name), p.sqlStyles(col.Codec), func() string { return b.secret("aes") })
		out := s.alias + "__" + name
		sb.WriteString(expr + " AS " + p.D.Quote(out))
		*outNames = append(*outNames, out)
		asm.Columns = append(asm.Columns, plan.OutCol{Index: *idx, Name: name, Column: name, Type: col.Type, Styles: p.clientStyles(col.Codec)})
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
	hasAES := false
	for _, c := range cols {
		if col := s.ent.Field(c.column); col != nil && col.Encrypted() {
			hasAES = true
		}
		if *idx > 0 {
			sb.WriteString(", ")
		}
		col := s.ent.Field(c.column)
		var expr string
		var styles []string
		typ := "text"
		switch {
		case c.fn != nil:
			e, err := p.columnFunction(b, s, c.column, c.fn)
			if err != nil {
				return err
			}
			expr = e
			typ = functionType(c.fn.Name, col)
			col = nil
		case c.sub != nil:
			e, err := p.subSelect(b, s, c.sub)
			if err != nil {
				return err
			}
			expr = "(" + e + ")"
			typ = p.subType(c.sub)
		default:
			e, _ := p.D.ReadExpr(p.qcol(s, c.column), p.sqlStyles(col.Codec), func() string { return b.secret("aes") })
			expr = e
			styles = p.clientStyles(col.Codec)
		}
		sb.WriteString(expr + " AS " + p.D.Quote(s.alias+"__"+c.name))
		*outNames = append(*outNames, s.alias+"__"+c.name)
		if col != nil {
			typ = col.Type
		}
		asm.Columns = append(asm.Columns, plan.OutCol{Index: *idx, Name: c.name, Column: c.column, Type: typ, Styles: styles})
		*idx++
	}
	if hasAES {
		version := s.ent.Field(s.ent.AESVersion)
		if version == nil {
			return &ir.Error{Code: "SCHEMA_INVALID", Msg: s.ent.Name + ": AES column requires an aes_version setting"}
		}
		// 고른 version column이 있으면 그것을 쓰고, 없을 때만 숨겨서 읽는다.
		for i, c := range asm.Columns {
			if c.Column == version.Name && len(c.Styles) == 0 {
				asm.AESVersion = &i
				break
			}
		}
		if asm.AESVersion == nil {
			if *idx > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString(p.qcol(s, version.Name) + " AS " + p.D.Quote(s.alias+"__"+version.Name))
			*outNames = append(*outNames, s.alias+"__"+version.Name)
			at := len(asm.Columns)
			asm.Columns = append(asm.Columns, plan.OutCol{Index: *idx, Name: version.Name, Column: version.Name, Type: version.Type, Hidden: true})
			asm.AESVersion = &at
			*idx++
		}
	}
	for _, j := range s.q.Joins {
		js := s.joins[j.Rel]
		child := &plan.Child{Rel: j.Rel, Kind: "join", Assemble: &plan.Assemble{Entity: js.ent.Name, Alias: js.alias}}
		if err := p.selectList(b, sb, js, child.Assemble, idx, outNames); err != nil {
			return err
		}
		asm.Children = append(asm.Children, child)
	}
	asm.Key = keyRefs(asm, s.ent.PK)
	return nil
}

type outCol struct {
	name, column string
	fn           *ir.Func
	sub          *ir.Sub
}

// projection resolves columns mode/add/remove/fn/sub into an ordered list.
func (p *Planner) projection(s *scope) ([]outCol, error) {
	c := s.q.Columns
	var base []string
	mode := ""
	if c != nil {
		mode = c.Mode
	}
	for _, col := range s.ent.Fields {
		switch mode {
		case "all":
			base = append(base, col.Name)
		case "none":
			if col.PrimaryKey || col.ForeignKey {
				base = append(base, col.Name)
			}
		default:
			if !col.SelectExplicit {
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
				if !contains(c.Remove, x) || s.ent.Field(x).PrimaryKey {
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
		for _, k := range r.Keys {
			if !contains(base, k.Left) {
				base = append(base, k.Left)
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
		fnNames := make([]string, 0, len(c.Fn))
		for name := range c.Fn {
			fnNames = append(fnNames, name)
		}
		slices.Sort(fnNames)
		for _, name := range fnNames {
			cf := c.Fn[name]
			out = append(out, outCol{name: name, column: cf.Column, fn: &cf.Fn})
		}
		subNames := make([]string, 0, len(c.Sub))
		for name := range c.Sub {
			subNames = append(subNames, name)
		}
		slices.Sort(subNames)
		for _, name := range subNames {
			out = append(out, outCol{name: name, sub: c.Sub[name]})
		}
	}
	return out, nil
}

func (p *Planner) renderJoins(b *builder, sb *strings.Builder, s *scope) error {
	for _, j := range s.q.Joins {
		js := s.joins[j.Rel]
		kw := " INNER JOIN "
		if j.Kind == "left" {
			kw = " LEFT JOIN "
		}
		sb.WriteString(kw + b.table(js.ent) + " AS " + p.D.Quote(js.alias) + " ON " + p.qcol(s, j.Left) + " = " + p.qcol(js, j.Right))
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
	placed := map[string]bool{}
	if s.q.Where != nil {
		placedJoins(s.q.Where, placed)
	}
	for _, j := range s.q.Joins {
		js := s.joins[j.Rel]
		if j.Query.Where != nil && len(j.Query.Where.Items) > 0 && !placed[j.Rel] {
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
		case it.Joined != nil:
			conn = it.Joined.Conn
			js := s.joins[it.Joined.Join]
			text, err = p.renderGroup(b, js, js.q.Where, false)
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
	if g.Not {
		out = "NOT " + out
	}
	return out, nil
}

func (p *Planner) renderPred(b *builder, s *scope, pr *ir.Pred) (string, error) {
	if pr.Op == "tuple_in" || pr.Op == "tuple_not_in" {
		cols := p.qualified(s, pr.Cols)
		var rows [][]string
		for i := 0; i < len(pr.Ps); i += len(pr.Cols) {
			row := make([]string, len(pr.Cols))
			for k, name := range pr.Cols {
				v, err := p.renderValue(b, s.ent.Field(name), pr.Ps[i+k])
				if err != nil {
					return "", err
				}
				row[k] = v
			}
			rows = append(rows, row)
		}
		return p.D.TupleIn(cols, rows, pr.Op == "tuple_not_in"), nil
	}
	col := s.ent.Field(pr.Column)
	lhs := p.qcol(s, pr.Column)
	if pr.Sub != nil {
		inner, err := p.subSelect(b, s, pr.Sub)
		if err != nil {
			return "", err
		}
		op := " IN "
		if pr.Op == "not_in" {
			op = " NOT IN "
		}
		return lhs + op + "(" + inner + ")", nil
	}
	if pr.Value != nil {
		arg := func() string { return b.param(pr.Value.Ps[0], valueFunctionArgType(pr.Value.Name)) }
		// datetime column과 비교하는 clock은 그 column의 소수 자리를 쓴다.
		precision := 6
		if col != nil && col.Type == "datetime" {
			precision = col.Precision
		}
		value, ok := p.D.ValueFunction(pr.Value.Name, arg, func() string { return b.now(precision) })
		if !ok {
			return "", &ir.Error{Code: "CAPABILITY_UNSUPPORTED", Msg: pr.Value.Name + " is not available on " + p.D.Name()}
		}
		return lhs + " " + cmp(pr.Op) + " " + value, nil
	}
	if pr.Fn != nil {
		fn, err := p.columnFunction(b, s, pr.Column, pr.Fn)
		if err != nil {
			return "", err
		}
		fnType := functionType(pr.Fn.Name, col)
		plain := func(i int) string { return b.param(i, fnType) }
		switch pr.Op {
		case "in", "not_in":
			phs := make([]string, len(pr.Ps))
			for k, i := range pr.Ps {
				phs[k] = plain(i)
			}
			op := " IN "
			if pr.Op == "not_in" {
				op = " NOT IN "
			}
			return fn + op + "(" + strings.Join(phs, ", ") + ")", nil
		case "between":
			return fn + " BETWEEN " + plain(pr.Ps[0]) + " AND " + plain(pr.Ps[1]), nil
		default:
			return fn + " " + cmp(pr.Op) + " " + plain(*pr.P), nil
		}
	}
	switch pr.Op {
	case "eq", "not_eq", "gt", "gte", "lt", "lte":
		if col.Encrypted() {
			if pr.Op != "eq" && pr.Op != "not_eq" {
				return "", &ir.Error{Code: "OPERATOR_NOT_ALLOWED", Msg: "AES columns support only equality through a declared blind index"}
			}
			if col.BlindIndex == "" {
				return "", &ir.Error{Code: "IR_INVALID", Msg: s.ent.Name + "." + col.Name + " requires a declared blind index for equality search"}
			}
			lhs = p.qcol(s, col.BlindIndex)
			rhs, err := p.renderBlindIndexValue(b, s.ent.Field(col.BlindIndex), *pr.P)
			if err != nil {
				return "", err
			}
			return lhs + " " + cmp(pr.Op) + " " + rhs, nil
		}
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
		if rs.ent.Field(pr.Ref.Column) == nil {
			return "", &ir.Error{Code: "COLUMN_UNKNOWN", Msg: rs.ent.Name + "." + pr.Ref.Column}
		}
		return lhs + " " + cmp(strings.TrimSuffix(pr.Op, "_col")) + " " + p.qcol(rs, pr.Ref.Column), nil
	case "in", "not_in":
		if col.Encrypted() {
			if col.BlindIndex == "" {
				return "", &ir.Error{Code: "IR_INVALID", Msg: s.ent.Name + "." + col.Name + " requires a declared blind index for equality search"}
			}
			lhs = p.qcol(s, col.BlindIndex)
			var phs []string
			for _, i := range pr.Ps {
				rhs, err := p.renderBlindIndexValue(b, s.ent.Field(col.BlindIndex), i)
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
		}
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
	case "contains":
		return p.D.Like(lhs, b.colParam(*pr.P, col, "like_contains")), nil
	case "contains_binary":
		return p.D.ContainsBinary(lhs, func(transform string) string { return b.colParam(*pr.P, col, transform) }), nil
	}
	return "", &ir.Error{Code: "OPERATOR_UNKNOWN", Msg: pr.Op}
}

// renderValue binds one value, wrapping it for SQL-side styles (hex/ip) so
// equality predicates on encrypted columns keep working.
func (p *Planner) renderValue(b *builder, col *runtimemodel.Field, i int) (string, error) {
	styles := p.sqlStyles(col.Codec)
	// SQL-side stages the dialect lacks (aes/hex/ip on PostgreSQL/SQLite) are
	// applied by the executor to the bound value: recorded on the slot.
	var host []string
	for _, st := range col.Codec {
		if (st == "aes" || st == "hex" || st == "ip") && !p.D.HandlesStyle(st) {
			host = append(host, st)
		}
	}
	if len(styles) == 0 {
		ph := b.colParam(i, col, "")
		b.binds[len(b.binds)-1].HostStyles = host
		return ph, nil
	}
	first := true
	e, _ := p.D.WriteExpr(func() string {
		if first {
			first = false
			ph := b.param(i, styleInputType(styles[0]))
			b.binds[len(b.binds)-1].HostStyles = host
			return ph
		}
		return b.secret("aes")
	}, styles)
	return e, nil
}

// renderBlindIndexValue binds plaintext for executor-side keyed hashing. The
// index key never reaches the compiler or the SQL text.
// index는 blind index column이며 slot의 type은 그 column의 type이다. 값은
// executor가 hash한 text다.
func (p *Planner) renderBlindIndexValue(b *builder, index *runtimemodel.Field, i int) (string, error) {
	ph := b.param(i, index.Type)
	b.binds[len(b.binds)-1].HostStyles = []string{"blind_index"}
	return ph, nil
}

// styleInputType은 SQL 쪽 style 함수가 placeholder에서 받는 값의 type이다.
// hex는 byte를, ip는 IP 주소 text를 받는다.
func styleInputType(style string) string {
	if style == "ip" {
		return "text"
	}
	return "bytes"
}

// valueFunctionArgType은 상대 시각 함수가 받는 간격 값의 type이다. 초는 소수를
// 받고 나머지 단위는 정수를 받는다.
func valueFunctionArgType(name string) string {
	if dialect.ValueFunctionUnits[name] == "second" {
		return "f64"
	}
	return "i32"
}

func (p *Planner) resolvePath(s *scope, path string) (*scope, error) {
	if path == "^" {
		cur := s
		for cur.parent != nil {
			cur = cur.parent
		}
		if cur.outer == nil {
			return nil, &ir.Error{Code: "IR_INVALID", Msg: "^ reference outside a subquery"}
		}
		return cur.outer, nil
	}
	cur := s
	for cur.parent != nil {
		cur = cur.parent
	}
	if path == "" {
		return cur, nil
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

func (p *Planner) insertStep(r *ir.Request) (*plan.Step, error) {
	b := &builder{p: p}
	ent := p.M.Entities[r.Entity]
	set := slices.Clone(r.Set)
	set = addBlindIndexAssignments(ent, set)
	if err := validateAESAssignments(ent, set, false); err != nil {
		return nil, err
	}
	if err := validateAuditAssignments(ent, set); err != nil {
		return nil, err
	}
	if err := validateRequiredAssignments(ent, set); err != nil {
		return nil, err
	}
	var cols, vals []string
	for _, a := range set {
		col := ent.Field(a.Column)
		if col.Identity {
			return nil, &ir.Error{Code: "IR_INVALID", Msg: "cannot set identity column " + a.Column}
		}
		cols = append(cols, p.D.Quote(a.Column))
		v, err := p.renderAssign(b, ent, col, &a)
		if err != nil {
			return nil, err
		}
		vals = append(vals, v)
	}
	// executor가 관리하는 column은 사용자 assignment 뒤에 AES key version, audit column 순서로 쓴다.
	managed := p.managedInsertColumns(ent, set)
	for _, c := range managed {
		cols = append(cols, p.D.Quote(c.column))
		vals = append(vals, c.value(b))
	}
	sql := "INSERT INTO " + b.table(ent) + " (" + strings.Join(cols, ", ") + ") VALUES (" + strings.Join(vals, ", ") + ")"
	if len(r.Rows) > 0 {
		// source maps each rendered column to its value in r.Set; derived
		// blind-index columns take the value of their AES source column.
		source := make([]int, len(set))
		for i, a := range set {
			source[i] = i
			if i >= len(r.Set) {
				src := blindIndexSource(ent, a.Column)
				source[i] = slices.IndexFunc(r.Set, func(x ir.Assign) bool { return x.Column == src.Name })
			}
		}
		for _, row := range r.Rows {
			more := make([]string, len(set))
			for i := range set {
				param := row[source[i]]
				a := ir.Assign{Column: set[i].Column, P: &param}
				v, err := p.renderAssign(b, ent, ent.Field(a.Column), &a)
				if err != nil {
					return nil, err
				}
				more[i] = v
			}
			for _, c := range managed {
				more = append(more, c.value(b))
			}
			sql += ", (" + strings.Join(more, ", ") + ")"
		}
		if b.err != nil {
			return nil, b.err
		}
		return &plan.Step{Role: "main", SQL: sql, Tables: b.tableList(), BindSlots: b.binds}, nil
	}
	if len(r.OnDuplicate) > 0 {
		duplicate := addBlindIndexAssignments(ent, slices.Clone(r.OnDuplicate))
		if err := validateAESAssignments(ent, duplicate, true); err != nil {
			return nil, err
		}
		if err := validateAuditAssignments(ent, duplicate); err != nil {
			return nil, err
		}
		r.OnDuplicate = duplicate
		var sets []string
		for _, a := range r.OnDuplicate {
			v, err := p.renderAssign(b, ent, ent.Field(a.Column), &a)
			if err != nil {
				return nil, err
			}
			sets = append(sets, p.D.Quote(a.Column)+" = "+v)
		}
		if version := ent.AESVersion; version != "" && assignsAES(ent, r.OnDuplicate) {
			sets = append(sets, p.D.Quote(version)+" = "+b.config("aes_version", ent.Field(version).Type))
		}
		// 기존 행을 바꾸는 duplicate update도 audit table의 update다.
		if ent.Audit != nil {
			sets = append(sets, p.D.Quote(ent.Audit.Column)+" = "+b.audit(ent))
		}
		if ent.Identity != "" && !p.D.InsertReturningID() {
			// MySQL idiom: make last insert id report the existing row on update
			sets = append(sets, p.D.Quote(ent.Identity)+" = LAST_INSERT_ID("+p.D.Quote(ent.Identity)+")")
		}
		sql += p.D.Upsert(conflictTarget(ent, set), strings.Join(sets, ", "))
	}
	if p.D.InsertReturningID() && ent.Identity != "" {
		sql += " RETURNING " + p.D.Quote(ent.Identity)
	}
	if b.err != nil {
		return nil, b.err
	}
	return &plan.Step{Role: "main", SQL: sql, Tables: b.tableList(), BindSlots: b.binds}, nil
}

// managedColumn은 executor가 insert마다 쓰는 column과 그 bind slot이다.
type managedColumn struct {
	column string
	value  func(*builder) string
}

// managedInsertColumns는 insert가 사용자 assignment 외에 쓰는 column이다:
// AES key version, audit column, sub-second clock이 없는 dialect의 `default now` column.
func (p *Planner) managedInsertColumns(ent *runtimemodel.Entity, set []ir.Assign) []managedColumn {
	var out []managedColumn
	if ent.AESVersion != "" && !assigned(set, ent.AESVersion) {
		out = append(out, managedColumn{ent.AESVersion, func(b *builder) string { return b.config("aes_version", ent.Field(ent.AESVersion).Type) }})
	}
	if ent.Audit != nil {
		out = append(out, managedColumn{ent.Audit.Column, func(b *builder) string { return b.audit(ent) }})
	}
	// sub-second clock이 없는 dialect의 `default now`는 millisecond만 가지므로
	// 사용자가 assign하지 않은 그 column에 executor의 microsecond clock을 쓴다.
	if p.D.HostNow() {
		for _, f := range ent.Fields {
			if f.DefaultNow && !assigned(set, f.Name) {
				out = append(out, managedColumn{f.Name, func(b *builder) string { return b.now(f.Precision) }})
			}
		}
	}
	return out
}

func assignsAES(ent *runtimemodel.Entity, set []ir.Assign) bool {
	for _, assign := range set {
		if col := ent.Field(assign.Column); col != nil && col.Encrypted() {
			return true
		}
	}
	return false
}

// validateAESAssignments preserves the row-level key-version invariant. The
// version is managed by the planner. An update that changes encrypted data
// must replace every AES column because one version describes the whole row.
func validateAESAssignments(ent *runtimemodel.Entity, set []ir.Assign, requireComplete bool) error {
	version := ent.AESVersion
	if version == "" {
		return nil
	}
	if assigned(set, version) {
		return &ir.Error{Code: "IR_INVALID", Msg: version + " is managed by the AES writer"}
	}
	if !requireComplete || !assignsAES(ent, set) {
		return nil
	}
	for _, col := range ent.Fields {
		if col.Encrypted() && !assigned(set, col.Name) {
			return &ir.Error{Code: "IR_INVALID", Msg: "AES update must assign every AES column; missing " + col.Name}
		}
	}
	return nil
}

// validateAuditAssignments는 audit column을 executor만 쓰게 한다.
func validateAuditAssignments(ent *runtimemodel.Entity, set []ir.Assign) error {
	if ent.Audit != nil && assigned(set, ent.Audit.Column) {
		return &ir.Error{Code: "IR_INVALID", Msg: ent.Name + "." + ent.Audit.Column + " is written by the executor from the audit of the transaction"}
	}
	return nil
}

// validateRequiredAssignments는 default가 없는 non-null column을 빼먹은
// insert를 database에 닿기 전에 거부한다. identity, AES key version, audit
// audit column은 executor나 database가 채운다.
func validateRequiredAssignments(ent *runtimemodel.Entity, set []ir.Assign) error {
	for _, col := range ent.Fields {
		if col.Null || col.Default || col.Identity || col.Name == ent.AESVersion || ent.Audit != nil && col.Name == ent.Audit.Column || assigned(set, col.Name) {
			continue
		}
		return &ir.Error{Code: "IR_INVALID", Msg: "required column " + ent.Name + "." + col.Name + " is not set"}
	}
	return nil
}

func addBlindIndexAssignments(ent *runtimemodel.Entity, set []ir.Assign) []ir.Assign {
	for _, assign := range slices.Clone(set) {
		col := ent.Field(assign.Column)
		if col == nil || !col.Encrypted() || col.BlindIndex == "" || assigned(set, col.BlindIndex) {
			continue
		}
		set = append(set, ir.Assign{Column: col.BlindIndex, P: assign.P, Null: assign.Null})
	}
	return set
}

func blindIndexSource(ent *runtimemodel.Entity, target string) *runtimemodel.Field {
	for _, col := range ent.Fields {
		if col.BlindIndex == target {
			return col
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
func conflictTarget(ent *runtimemodel.Entity, set []ir.Assign) []string {
	inserted := map[string]bool{}
	for _, a := range set {
		inserted[a.Column] = true
	}
	for _, uk := range ent.Uniques {
		all := true
		for _, c := range uk.Columns {
			if !inserted[c] {
				all = false
			}
		}
		if all {
			return uk.Columns
		}
	}
	return ent.PK
}

func (p *Planner) renderAssign(b *builder, ent *runtimemodel.Entity, col *runtimemodel.Field, a *ir.Assign) (string, error) {
	if source := blindIndexSource(ent, col.Name); source != nil {
		if a.PlusP != nil || a.MinusP != nil {
			return "", &ir.Error{Code: "IR_INVALID", Msg: "blind index assignment must use its AES source value"}
		}
		if a.Null {
			return "NULL", nil
		}
		return p.renderBlindIndexValue(b, col, *a.P)
	}
	switch {
	case a.PlusP != nil:
		// the reference is table-qualified: inside ON CONFLICT DO UPDATE a bare name is ambiguous
		return p.D.Quote(ent.Table) + "." + p.D.Quote(col.Name) + " + " + b.colParam(*a.PlusP, col, ""), nil
	case a.MinusP != nil:
		// clamp at zero
		q := p.D.Quote(ent.Table) + "." + p.D.Quote(col.Name)
		ph := b.colParam(*a.MinusP, col, "")
		return "CASE WHEN " + q + " > " + ph + " THEN " + q + " - " + b.colParam(*a.MinusP, col, "") + " ELSE 0 END", nil
	case a.Null:
		return "NULL", nil
	default:
		return p.renderValue(b, col, *a.P)
	}
}

func (p *Planner) updateStep(r *ir.Request) (*plan.Step, error) {
	b := &builder{p: p}
	ent := p.M.Entities[r.Entity]
	set := addBlindIndexAssignments(ent, slices.Clone(r.Set))
	if err := validateAESAssignments(ent, set, true); err != nil {
		return nil, err
	}
	if err := validateAuditAssignments(ent, set); err != nil {
		return nil, err
	}
	root := p.buildScopes(&r.Query, ent.Table, nil)
	var sets []string
	for _, a := range set {
		col := ent.Field(a.Column)
		if col.PrimaryKey || col.Identity {
			return nil, &ir.Error{Code: "IR_INVALID", Msg: "cannot update " + a.Column}
		}
		v, err := p.renderAssign(b, ent, col, &a)
		if err != nil {
			return nil, err
		}
		sets = append(sets, p.D.Quote(a.Column)+" = "+v)
	}
	if version := ent.AESVersion; version != "" && assignsAES(ent, set) {
		sets = append(sets, p.D.Quote(version)+" = "+b.config("aes_version", ent.Field(version).Type))
	}
	// updated setting의 column은 executor가 statement 시각으로 쓴다. 사용자가
	// 직접 assign하면 그 값이 남는다.
	if ent.Updated != "" && !assigned(r.Set, ent.Updated) {
		sets = append(sets, p.D.Quote(ent.Updated)+" = "+p.statementTime(b, ent.Field(ent.Updated)))
	}
	if ent.Audit != nil {
		sets = append(sets, p.D.Quote(ent.Audit.Column)+" = "+b.audit(ent))
	}
	where, err := p.renderGroup(b, root, r.Where, true)
	if err != nil {
		return nil, err
	}
	if r.Optimistic != nil {
		where += " AND " + p.qcol(root, r.Optimistic.Column) + " = " + b.colParam(r.Optimistic.P, root.ent.Field(r.Optimistic.Column), "")
	}
	if ent.SoftDelete != "" {
		where += " AND " + p.qcol(root, ent.SoftDelete) + " IS NULL"
	}
	sql := "UPDATE " + b.table(ent) + " SET " + strings.Join(sets, ", ") + " WHERE " + where
	if b.err != nil {
		return nil, b.err
	}
	return &plan.Step{Role: "main", SQL: sql, Tables: b.tableList(), BindSlots: b.binds}, nil
}

// statementTime은 updated와 soft delete가 datetime column에 쓰는 statement
// 시각이다. sub-second clock이 없는 dialect는 executor의 microsecond clock을
// bind하고, 나머지는 column의 소수 자리로 database clock을 쓴다.
func (p *Planner) statementTime(b *builder, col *runtimemodel.Field) string {
	if p.D.HostNow() {
		return b.now(col.Precision)
	}
	return p.D.Now(col.Precision)
}

func (p *Planner) deleteStep(r *ir.Request) (*plan.Step, error) {
	b := &builder{p: p}
	ent := p.M.Entities[r.Entity]
	root := p.buildScopes(&r.Query, ent.Table, nil)
	// soft delete는 UPDATE이므로 audit table이면 audit column도 쓴다.
	var sets []string
	if ent.SoftDelete != "" {
		sets = append(sets, p.D.Quote(ent.SoftDelete)+" = "+p.statementTime(b, ent.Field(ent.SoftDelete)))
		if ent.Audit != nil {
			sets = append(sets, p.D.Quote(ent.Audit.Column)+" = "+b.audit(ent))
		}
	}
	where, err := p.renderGroup(b, root, r.Where, true)
	if err != nil {
		return nil, err
	}
	if ent.SoftDelete != "" {
		where += " AND " + p.qcol(root, ent.SoftDelete) + " IS NULL"
		if b.err != nil {
			return nil, b.err
		}
		return &plan.Step{Role: "main", SQL: "UPDATE " + b.table(ent) + " SET " + strings.Join(sets, ", ") + " WHERE " + where, Tables: b.tableList(), BindSlots: b.binds}, nil
	}
	sql := "DELETE FROM " + b.table(ent) + " WHERE " + where
	if b.err != nil {
		return nil, b.err
	}
	return &plan.Step{Role: "main", SQL: sql, Tables: b.tableList(), BindSlots: b.binds}, nil
}

// restoreStep은 soft delete한 행 하나를 되돌리는 update다. where는 primary key나
// unique key 하나의 모든 column을 eq 값으로 한 번씩 이름한다. 지워진 행만
// 고치므로 지워지지 않은 행과 없는 행은 아무것도 바꾸지 않는다. set은 되돌리는
// 행에 함께 쓰는 새 값이며 update의 assignment와 같은 규칙을 따른다. 그 뒤에
// soft delete column을 비우고, audit table이면 audit column을 쓴다. updated
// column은 soft delete처럼 쓰지 않는다.
func (p *Planner) restoreStep(r *ir.Request) (*plan.Step, error) {
	ent := p.M.Entities[r.Entity]
	if ent.SoftDelete == "" {
		return nil, &ir.Error{Code: "IR_INVALID", Msg: "restore of " + ent.Name + ", which has no soft_delete setting"}
	}
	if err := restoreKey(ent, r.Where); err != nil {
		return nil, err
	}
	set := addBlindIndexAssignments(ent, slices.Clone(r.Set))
	if err := validateAESAssignments(ent, set, true); err != nil {
		return nil, err
	}
	if err := validateAuditAssignments(ent, set); err != nil {
		return nil, err
	}
	b := &builder{p: p}
	root := p.buildScopes(&r.Query, ent.Table, nil)
	var sets []string
	for _, a := range set {
		col := ent.Field(a.Column)
		if col.PrimaryKey || col.Identity || col.Name == ent.SoftDelete {
			return nil, &ir.Error{Code: "IR_INVALID", Msg: "restore cannot assign " + a.Column}
		}
		v, err := p.renderAssign(b, ent, col, &a)
		if err != nil {
			return nil, err
		}
		sets = append(sets, p.D.Quote(a.Column)+" = "+v)
	}
	if version := ent.AESVersion; version != "" && assignsAES(ent, set) {
		sets = append(sets, p.D.Quote(version)+" = "+b.config("aes_version", ent.Field(version).Type))
	}
	sets = append(sets, p.D.Quote(ent.SoftDelete)+" = NULL")
	if ent.Audit != nil {
		sets = append(sets, p.D.Quote(ent.Audit.Column)+" = "+b.audit(ent))
	}
	where, err := p.renderGroup(b, root, r.Where, true)
	if err != nil {
		return nil, err
	}
	where += " AND " + p.qcol(root, ent.SoftDelete) + " IS NOT NULL"
	if b.err != nil {
		return nil, b.err
	}
	return &plan.Step{Role: "main", SQL: "UPDATE " + b.table(ent) + " SET " + strings.Join(sets, ", ") + " WHERE " + where, Tables: b.tableList(), BindSlots: b.binds}, nil
}

// restoreKey는 restore의 where가 primary key나 unique key 하나의 모든 column을
// and로 이은 eq 값 조건으로 한 번씩 이름하는지 확인한다.
func restoreKey(ent *runtimemodel.Entity, where *ir.Group) error {
	invalid := &ir.Error{Code: "IR_INVALID", Msg: "restore of " + ent.Name + " names every column of its primary key or of one unique key once with an eq value"}
	var columns []string
	for i, item := range where.Items {
		pr := item.Pred
		if pr == nil || pr.Op != "eq" || pr.P == nil || pr.Fn != nil || pr.Value != nil || pr.Ref != nil || pr.Sub != nil || (i > 0 && pr.Conn != "and") || slices.Contains(columns, pr.Column) {
			return invalid
		}
		columns = append(columns, pr.Column)
	}
	sameColumns := func(key []string) bool {
		return len(key) == len(columns) && !slices.ContainsFunc(key, func(c string) bool { return !slices.Contains(columns, c) })
	}
	if sameColumns(ent.PK) || slices.ContainsFunc(ent.Uniques, func(k runtimemodel.Key) bool { return sameColumns(k.Columns) }) {
		return nil
	}
	return invalid
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

// sqlStyles keeps only the stages the dialect applies in SQL; clientStyles the
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

func (p *Planner) clientStyles(styles []string) []string {
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

func sortedKeys[V any](m map[string]V) []string {
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

// placedJoins collects the joins whose conditions a group places.
func placedJoins(g *ir.Group, out map[string]bool) {
	for _, it := range g.Items {
		if it.Joined != nil {
			out[it.Joined.Join] = true
		}
		if it.Group != nil {
			placedJoins(it.Group, out)
		}
	}
}

// columnFunction renders an ORM column function on a column of s.
func (p *Planner) columnFunction(b *builder, s *scope, column string, f *ir.Func) (string, error) {
	// column 함수의 인자는 아직 없다(dialect.ColumnFunctionArity는 모두 0). 인자의
	// type을 선언하지 않은 함수가 인자를 받으면 type 없는 slot으로 planner 오류다.
	out, ok := p.D.ColumnFunction(f.Name, p.qcol(s, column), func(i int) string { return b.param(f.Ps[i], "") })
	if !ok {
		return "", &ir.Error{Code: "CAPABILITY_UNSUPPORTED", Msg: f.Name + " is not available on " + p.D.Name()}
	}
	return out, nil
}

// subSelect renders a subquery for an IN list or a scalar column. The
// subquery root gets its own alias and resolves "^" refs against outer.
func (p *Planner) subSelect(b *builder, outer *scope, sub *ir.Sub) (string, error) {
	b.subs++
	root := p.buildScopes(sub.Query, "s"+strconv.Itoa(b.subs), nil)
	root.outer = outer
	var sb strings.Builder
	sb.WriteString("SELECT ")
	switch sub.Agg {
	case "sum":
		sb.WriteString("COALESCE(SUM(" + p.qcol(root, sub.Column) + "), 0)")
	case "avg":
		sb.WriteString("AVG(" + p.qcol(root, sub.Column) + ")")
	case "count":
		sb.WriteString("COUNT(*)")
	default:
		sb.WriteString(p.qcol(root, sub.Column))
	}
	sb.WriteString(" FROM " + b.table(root.ent) + " AS " + p.D.Quote(root.alias))
	if err := p.renderJoins(b, &sb, root); err != nil {
		return "", err
	}
	var where []string
	if root.ent.SoftDelete != "" {
		where = append(where, p.qcol(root, root.ent.SoftDelete)+" IS NULL")
	}
	if sub.Query.Where != nil && len(sub.Query.Where.Items) > 0 {
		w, err := p.renderGroup(b, root, sub.Query.Where, true)
		if err != nil {
			return "", err
		}
		where = append(where, w)
	}
	if err := p.collectJoinWhere(b, root, &where); err != nil {
		return "", err
	}
	if len(where) > 0 {
		sb.WriteString(" WHERE " + strings.Join(where, " AND "))
	}
	if len(sub.Query.GroupBy) > 0 {
		sb.WriteString(" GROUP BY " + p.renderGroupBy(root, sub.Query))
	}
	return sb.String(), nil
}

// functionType is the assembled type of a column function result.
func functionType(name string, col *runtimemodel.Field) string {
	switch name {
	case "day_of_week", "year", "month":
		return "i64"
	case "date":
		return "date"
	}
	if col != nil {
		return col.Type
	}
	return "text"
}

// subType is the assembled type of a scalar subquery column.
func (p *Planner) subType(sub *ir.Sub) string {
	switch sub.Agg {
	case "count":
		return "i64"
	case "avg":
		return "f64"
	}
	if c := p.M.Entities[sub.Query.Entity].Field(sub.Column); c != nil {
		return c.Type
	}
	return "text"
}
