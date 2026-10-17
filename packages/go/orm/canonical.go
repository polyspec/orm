package orm

import (
	"fmt"
	"maps"
	"slices"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// canonicalize rewrites r so that its plan, and therefore its plan cache entry,
// does not depend on the length of an IN list. Each IN list is padded to the
// next power of two by repeating its last value (the rule padIndexes of
// root_in.go applies to split parts; IN and NOT IN are unchanged by a repeated
// value), and every parameter reference gets a slot of its own in walk order.
// The IR and the parameters are then renumbered from the walk alone, so two
// requests of one statement shape whose lists fall in the same power-of-two
// bucket share one shape key and one plan, and each execution binds its own
// values through the same slots.
//
// The walk visits every field that holds a parameter index in a fixed order;
// map entries are visited in sorted key order, so the numbering is the same on
// every run.
func canonicalize(r *request) error {
	c := &canonicalizer{params: r.params, used: make([]bool, len(r.params))}
	req := r.ir
	req.Query = c.query(r.ir.Query)
	req.Set = c.assigns(r.ir.Set)
	req.OnDuplicate = c.assigns(r.ir.OnDuplicate)
	if r.ir.Rows != nil {
		req.Rows = make([][]int, len(r.ir.Rows))
		for i, row := range r.ir.Rows {
			req.Rows[i] = c.ints(row)
		}
	}
	if o := r.ir.Optimistic; o != nil {
		v := *o
		v.P = c.index(o.P)
		req.Optimistic = &v
	}
	if c.err != nil {
		return c.err
	}
	// A parameter no reference names keeps its value after the slots, so the
	// request still holds exactly the values it was sent with.
	for i, u := range c.used {
		if !u {
			c.out = append(c.out, c.params[i])
		}
	}
	req.NParams = len(c.out)
	r.ir = req
	r.params = c.out
	r.canonical = true
	return nil
}

type canonicalizer struct {
	params []any
	out    []any
	used   []bool
	err    error
}

// index adds one slot holding the value of parameter p and returns its index.
// A reference past the parameters is the IR_INVALID that the validator reports.
func (c *canonicalizer) index(p int) int {
	if p < 0 || p >= len(c.params) {
		if c.err == nil {
			c.err = &ir.Error{Code: "IR_INVALID", Msg: fmt.Sprintf("param index %d out of range (n_params %d)", p, len(c.params))}
		}
		return p
	}
	c.used[p] = true
	c.out = append(c.out, c.params[p])
	return len(c.out) - 1
}

func (c *canonicalizer) ptr(p *int) *int {
	if p == nil {
		return nil
	}
	v := c.index(*p)
	return &v
}

func (c *canonicalizer) ints(ps []int) []int {
	if ps == nil {
		return nil
	}
	out := make([]int, len(ps))
	for i, p := range ps {
		out[i] = c.index(p)
	}
	return out
}

// list pads an IN list to its bucket: the slots past the last value repeat it.
func (c *canonicalizer) list(ps []int) []int {
	n := len(ps)
	if n == 0 {
		return c.ints(ps)
	}
	bucket := 1
	for bucket < n {
		bucket <<= 1
	}
	out := make([]int, bucket)
	for j := range out {
		out[j] = c.index(ps[min(j, n-1)])
	}
	return out
}

func (c *canonicalizer) fn(f *ir.Func) *ir.Func {
	if f == nil {
		return nil
	}
	v := *f
	v.Ps = c.ints(f.Ps)
	return &v
}

func (c *canonicalizer) sub(s *ir.Sub) *ir.Sub {
	if s == nil {
		return nil
	}
	v := *s
	v.Query = c.queryPtr(s.Query)
	return &v
}

func (c *canonicalizer) queryPtr(q *ir.Query) *ir.Query {
	if q == nil {
		return nil
	}
	v := c.query(*q)
	return &v
}

func (c *canonicalizer) assigns(as []ir.Assign) []ir.Assign {
	if as == nil {
		return nil
	}
	out := make([]ir.Assign, len(as))
	for i, a := range as {
		v := a
		v.P = c.ptr(a.P)
		v.PlusP = c.ptr(a.PlusP)
		v.MinusP = c.ptr(a.MinusP)
		out[i] = v
	}
	return out
}

func (c *canonicalizer) group(g *ir.Group) *ir.Group {
	if g == nil {
		return nil
	}
	v := *g
	v.Items = make([]ir.Item, len(g.Items))
	for i, it := range g.Items {
		var out ir.Item
		out.Pred = c.pred(it.Pred)
		out.Group = c.group(it.Group)
		if it.Joined != nil {
			j := *it.Joined
			out.Joined = &j
		}
		v.Items[i] = out
	}
	return &v
}

func (c *canonicalizer) pred(p *ir.Pred) *ir.Pred {
	if p == nil {
		return nil
	}
	v := *p
	v.P = c.ptr(p.P)
	if (p.Op == "in" || p.Op == "not_in") && p.Sub == nil {
		v.Ps = c.list(p.Ps)
	} else {
		v.Ps = c.ints(p.Ps)
	}
	v.Fn = c.fn(p.Fn)
	v.Value = c.fn(p.Value)
	v.Sub = c.sub(p.Sub)
	if p.Ref != nil {
		ref := *p.Ref
		v.Ref = &ref
	}
	v.Cols = slices.Clone(p.Cols)
	return &v
}

func (c *canonicalizer) query(q ir.Query) ir.Query {
	out := q
	if q.Columns != nil {
		cols := *q.Columns
		cols.Add, cols.Remove = slices.Clone(q.Columns.Add), slices.Clone(q.Columns.Remove)
		cols.Fn, cols.Sub = nil, nil
		if q.Columns.Fn != nil {
			cols.Fn = make(map[string]ir.ColFunc, len(q.Columns.Fn))
			for _, k := range slices.Sorted(maps.Keys(q.Columns.Fn)) {
				v := q.Columns.Fn[k]
				v.Fn = *c.fn(&v.Fn)
				cols.Fn[k] = v
			}
		}
		if q.Columns.Sub != nil {
			cols.Sub = make(map[string]*ir.Sub, len(q.Columns.Sub))
			for _, k := range slices.Sorted(maps.Keys(q.Columns.Sub)) {
				cols.Sub[k] = c.sub(q.Columns.Sub[k])
			}
		}
		out.Columns = &cols
	}
	out.On = c.group(q.On)
	out.Where = c.group(q.Where)
	if q.Joins != nil {
		out.Joins = make([]*ir.Join, len(q.Joins))
		for i, j := range q.Joins {
			if j == nil {
				continue
			}
			v := *j
			v.Query = c.queryPtr(j.Query)
			out.Joins[i] = &v
		}
	}
	if q.Relations != nil {
		out.Relations = make([]*ir.Relation, len(q.Relations))
		for i, rel := range q.Relations {
			if rel == nil {
				continue
			}
			v := *rel
			v.Keys = slices.Clone(rel.Keys)
			v.Query = c.queryPtr(rel.Query)
			out.Relations[i] = &v
		}
	}
	if q.Order != nil {
		out.Order = make([]ir.Order, len(q.Order))
		for i, o := range q.Order {
			o.Fn = c.fn(o.Fn)
			out.Order[i] = o
		}
	}
	out.GroupBy = slices.Clone(q.GroupBy)
	if q.Limit != nil {
		l := *q.Limit
		out.Limit = &l
	}
	if q.IfParent != nil {
		v := *q.IfParent
		v.P = c.index(q.IfParent.P)
		out.IfParent = &v
	}
	return out
}
