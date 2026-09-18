package orm

import (
	"fmt"
	"slices"
	"strings"

	"github.com/polyspec/orm/engine/ir"
)

// request is one statement under construction: the value-free IR plus values.
type request struct {
	ir     ir.Request
	params []any
	err    error
	// nodes maps each model of the statement to the IR node it produced;
	// assembly uses it to create child models.
	joins     map[string]*Core
	relations map[*ir.Relation]*Core
	// external lists, per parent model, the relations whose child has its
	// own connection; they run as separate statements after the parents load.
	external map[*Core][]relSpec
}

func (r *request) param(v any) int {
	r.params = append(r.params, v)
	return len(r.params) - 1
}

func (r *request) fail(err error) {
	if r.err == nil {
		r.err = err
	}
}

// frame is one statement being built: the models it contains and their join paths.
type frame struct {
	root   *Core
	paths  map[*Core]string
	parent map[*Core]*Core
	placed map[*Core]bool
	// outer is the model that owns a subquery; the subquery refers to it as "^".
	outer *Core
}

func newFrame(root *Core, outer *Core) *frame {
	f := &frame{root: root, paths: map[*Core]string{root: ""}, parent: map[*Core]*Core{}, placed: map[*Core]bool{}, outer: outer}
	f.register(root, "")
	return f
}

// register assigns join names and paths before any condition is rendered, so
// a condition may reference a join added later in the chain.
func (f *frame) register(c *Core, prefix string) {
	for _, j := range c.joins {
		name := j.child.resultName(false)
		path := prefix + name
		f.paths[j.child] = path
		f.parent[j.child] = c
		f.register(j.child, path+"/")
	}
}

// resultName is the relation or join result name: the alias, otherwise
// <table>_model or <table>_models.
func (c *Core) resultName(many bool) string {
	if c.alias != "" {
		return snake(c.alias)
	}
	if many {
		return c.ent.Name + "_models"
	}
	return c.ent.Name + "_model"
}

// snake converts a generated PascalCase name to snake_case.
func snake(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('_')
			}
			b.WriteRune(r + ('a' - 'A'))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// build renders the model as a request of kind.
func (c *Core) build(kind string) *request {
	r := &request{joins: map[string]*Core{}, relations: map[*ir.Relation]*Core{}}
	r.ir.IRVersion = ir.Version
	r.ir.SchemaHash = c.ent.Schema.Hash
	r.ir.Kind = kind
	if c.err != nil {
		r.fail(c.err)
		return r
	}
	f := newFrame(c, nil)
	q := r.query(c, f, "")
	if q != nil {
		r.ir.Query = *q
	}
	r.ir.NParams = len(r.params)
	return r
}

func (r *request) query(c *Core, f *frame, path string) *ir.Query {
	if c.err != nil {
		r.fail(c.err)
		return nil
	}
	if c.where.pending != "" {
		r.fail(configErr("connector %s without a following condition", c.where.pending))
		return nil
	}
	q := &ir.Query{Entity: c.ent.Name, ForceIdx: c.index, Lock: c.lock, Limit: c.limit}
	q.Columns = r.columns(c)
	for _, j := range c.joins {
		childPath := f.paths[j.child]
		name := childPath[strings.LastIndexByte(childPath, '/')+1:]
		if _, dup := r.joins[childPath]; dup {
			r.fail(configErr("join result name %s is used twice", name))
			return nil
		}
		r.joins[childPath] = j.child
		child := r.query(j.child, f, childPath)
		if child == nil {
			return nil
		}
		if j.child.on != nil {
			child.On = r.group(j.child.on, j.child, f)
		}
		q.Joins = append(q.Joins, &ir.Join{Rel: name, Kind: j.kind, Left: j.left, Right: j.right, Query: child})
	}
	if len(c.where.items) > 0 {
		q.Where = r.group(&c.where, c, f)
	}
	for _, rel := range c.relations {
		if rel.child.conn != nil {
			if rel.child.limit != nil {
				r.fail(&ir.Error{Code: CodeLimitInRelation, Msg: rel.child.ent.Name + " relation uses limit; use groupLimit"})
				return nil
			}
			if r.external == nil {
				r.external = map[*Core][]relSpec{}
			}
			r.external[c] = append(r.external[c], rel)
			continue
		}
		child := r.relation(rel)
		if child == nil {
			return nil
		}
		q.Relations = append(q.Relations, child)
	}
	for _, o := range c.order {
		switch {
		case o.random:
			q.Order = append(q.Order, ir.Order{Random: true})
		case o.raw != nil:
			q.Order = append(q.Order, ir.Order{Expr: o.raw.sql})
		default:
			item := ir.Order{Column: o.column, Desc: o.desc}
			if o.fn != nil {
				fn := o.fn.irFunc(r.param)
				item.Fn = &fn
			}
			q.Order = append(q.Order, item)
		}
	}
	q.GroupBy = slices.Clone(c.groupBy)
	for i, g := range c.groupRaw {
		q.GroupByExpr = append(q.GroupByExpr, ir.GroupExpr{Expr: g.sql, As: fmt.Sprintf("group_%d", i+1)})
	}
	return q
}

// relation renders a relation child as its own statement.
func (r *request) relation(rel relSpec) *ir.Relation {
	ch := rel.child
	f := newFrame(ch, nil)
	q := r.query(ch, f, "")
	if q == nil {
		return nil
	}
	if ch.limit != nil {
		r.fail(&ir.Error{Code: CodeLimitInRelation, Msg: ch.ent.Name + " relation uses limit; use groupLimit"})
		return nil
	}
	kind := "one"
	if rel.many {
		kind = "many"
	}
	q.Flatten = ch.parentNode
	q.LimitPerParent = ch.groupLimit
	q.NoCascadeDelete = ch.deleteLock
	q.KeyBy = ch.keyName
	if ch.possible != nil {
		q.IfParent = &ir.IfParent{Column: ch.possible.column, P: r.param(ch.possible.value)}
	}
	out := &ir.Relation{Rel: ch.resultName(rel.many), Kind: kind, Left: ch.matchLeft, Right: ch.matchRight, Query: q}
	r.relations[out] = ch
	return out
}

func (r *request) columns(c *Core) *ir.Columns {
	spec := c.columns
	out := &ir.Columns{Mode: spec.mode, Add: slices.Clone(spec.add), Remove: slices.Clone(spec.remove)}
	for _, name := range spec.order {
		if fs, ok := spec.formats[name]; ok {
			if strings.Count(fs.format, "%s") != 1 {
				r.fail(configErr("column format for %s must contain one %%s", name))
				return nil
			}
			if out.Expr == nil {
				out.Expr = map[string]ir.Expr{}
			}
			out.Expr[name] = ir.Expr{SQL: strings.Replace(fs.format, "%s", "{"+fs.column+"}", 1)}
		}
		if fs, ok := spec.funcs[name]; ok {
			if out.Fn == nil {
				out.Fn = map[string]ir.ColFunc{}
			}
			out.Fn[name] = ir.ColFunc{Column: fs.column, Fn: fs.fn.irFunc(r.param)}
		}
		if raw, ok := spec.raws[name]; ok {
			if out.Expr == nil {
				out.Expr = map[string]ir.Expr{}
			}
			pred := r.rawPred(&raw)
			out.Expr[name] = ir.Expr{SQL: pred.Expr, Ps: pred.Ps}
		}
		if fn, ok := spec.subs[name]; ok {
			sub := r.subquery(fn(c.self), c, true)
			if sub == nil {
				return nil
			}
			if out.Sub == nil {
				out.Sub = map[string]*ir.Sub{}
			}
			out.Sub[name] = sub
		}
	}
	if out.Mode == "" && len(out.Add) == 0 && len(out.Remove) == 0 && len(out.Expr) == 0 && len(out.Fn) == 0 && len(out.Sub) == 0 {
		return nil
	}
	return out
}

// rawPred binds the values of a raw fragment. `{column}` references stay in
// the fragment; the engine checks and qualifies them.
func (r *request) rawPred(raw *rawSpec) *ir.Pred {
	if n := strings.Count(raw.sql, "?"); n != len(raw.binds) {
		r.fail(&ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("raw SQL has %d placeholders and %d binds", n, len(raw.binds))})
	}
	sql := raw.sql
	ps := make([]int, len(raw.binds))
	for i, b := range raw.binds {
		ps[i] = r.param(b)
	}
	return &ir.Pred{Expr: sql, Ps: ps}
}

func (r *request) group(g *condGroup, owner *Core, f *frame) *ir.Group {
	out := &ir.Group{}
	for _, node := range g.items {
		item := ir.Item{}
		switch {
		case node.pred != nil:
			item.Pred = r.pred(node.pred, owner, f)
			if item.Pred == nil {
				return out
			}
			item.Pred.Conn = node.conn
		case node.raw != nil:
			item.Pred = r.rawPred(node.raw)
			item.Pred.Conn = node.conn
		case node.group != nil:
			item.Group = r.group(node.group, owner, f)
			item.Group.Conn = node.conn
		case node.joined != nil:
			child := node.joined
			path, ok := f.paths[child]
			if !ok || child == f.root {
				r.fail(&ir.Error{Code: CodeConfig, Msg: child.ent.Name + " is not joined in the statement"})
				return out
			}
			if f.parent[child] != owner.subject() {
				r.fail(configErr("%s conditions must be placed in the model it is joined to", child.ent.Name))
				return out
			}
			if f.placed[child] {
				r.fail(configErr("%s conditions are placed twice", child.ent.Name))
				return out
			}
			f.placed[child] = true
			if len(child.where.items) == 0 {
				r.fail(configErr("%s has no condition to place", child.ent.Name))
				return out
			}
			item.Joined = &ir.JoinedRef{Conn: node.conn, Join: path[strings.LastIndexByte(path, '/')+1:]}
		}
		out.Items = append(out.Items, item)
	}
	return out
}

func (r *request) pred(p *predSpec, owner *Core, f *frame) *ir.Pred {
	out := &ir.Pred{Column: p.column, Op: p.op}
	switch {
	case p.fulltext:
		out.Column = ""
		out.Match = p.cols
		i := r.param(p.value)
		out.P = &i
	case p.tuple:
		out.Column = ""
		out.Cols = p.cols
		for _, row := range p.value.([][]any) {
			for _, v := range row {
				out.Ps = append(out.Ps, r.param(v))
			}
		}
	case p.between:
		for _, v := range p.value.([]any) {
			out.Ps = append(out.Ps, r.param(v))
		}
	case p.list:
		for _, v := range padIn(p.value.([]any)) {
			out.Ps = append(out.Ps, r.param(v))
		}
	case p.isNull:
	case p.ref != nil:
		path, err := f.pathOf(p.ref.subject())
		if err != nil {
			r.fail(err)
			return nil
		}
		out.Ref = &ir.ColRef{Path: path, Column: p.refCol}
	case p.sub != nil:
		out.Sub = r.subquery(p.sub.self, owner.subject(), false)
		if out.Sub == nil {
			return nil
		}
	case p.fn != nil && p.fn.column:
		fn := p.fn.irFunc(r.param)
		out.Fn = &fn
		i := r.param(p.value)
		out.P = &i
	case p.fn != nil:
		fn := p.fn.irFunc(r.param)
		out.Value = &fn
	default:
		i := r.param(p.value)
		out.P = &i
	}
	return out
}

func (f *frame) pathOf(c *Core) (string, error) {
	if path, ok := f.paths[c]; ok {
		return path, nil
	}
	if f.outer != nil && c == f.outer {
		return "^", nil
	}
	return "", &ir.Error{Code: CodeConfig, Msg: c.ent.Name + " is not part of the statement"}
}

// subquery renders an unexecuted model as a subquery. scalar selects a
// column subquery, which may aggregate.
func (r *request) subquery(m Model, outer *Core, scalar bool) *ir.Sub {
	if m == nil {
		r.fail(configErr("subquery callback returned no model"))
		return nil
	}
	c := m.Orm_()
	if c.conn != nil {
		r.fail(configErr("a subquery model cannot have its own connection"))
		return nil
	}
	if len(c.relations) > 0 {
		r.fail(configErr("a subquery model cannot load relations"))
		return nil
	}
	f := newFrame(c, outer)
	q := r.query(c, f, "")
	if q == nil {
		return nil
	}
	sub := &ir.Sub{Query: q}
	switch {
	case scalar && c.agg != "":
		sub.Agg = c.aggFn
		sub.Column = c.agg
	case len(c.columns.add) == 1:
		sub.Column = c.columns.add[0]
	default:
		r.fail(configErr("a subquery model must add exactly one column with addColumn<Col>()"))
		return nil
	}
	q.Columns = nil
	return sub
}

// padIn rounds a list up to a power of two by repeating its last value, so
// the number of distinct statements stays logarithmic in the list length.
func padIn(vs []any) []any {
	n := 1
	for n < len(vs) {
		n <<= 1
	}
	if n == len(vs) {
		return vs
	}
	out := make([]any, n)
	copy(out, vs)
	for i := len(vs); i < n; i++ {
		out[i] = vs[len(vs)-1]
	}
	return out
}
