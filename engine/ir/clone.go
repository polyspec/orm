package ir

import (
	"maps"
	"slices"
)

// CloneQuery copies every mutable part of a query tree before it is attached
// to another request. Parameter values live outside this tree.
func CloneQuery(q Query) Query {
	out := q
	if q.Columns != nil {
		c := *q.Columns
		c.Add, c.Remove = slices.Clone(c.Add), slices.Clone(c.Remove)
		c.As, c.Expr = maps.Clone(c.As), maps.Clone(c.Expr)
		out.Columns = &c
	}
	out.On, out.Where, out.Having = cloneGroup(q.On), cloneGroup(q.Where), cloneGroup(q.Having)
	out.Joins = slices.Clone(q.Joins)
	for i, j := range q.Joins {
		if j == nil {
			continue
		}
		v := *j
		if j.Query != nil {
			tree := CloneQuery(*j.Query)
			v.Query = &tree
		}
		out.Joins[i] = &v
	}
	out.Relations = slices.Clone(q.Relations)
	for i, r := range q.Relations {
		if r == nil {
			continue
		}
		v := *r
		if r.Query != nil {
			tree := CloneQuery(*r.Query)
			v.Query = &tree
		}
		out.Relations[i] = &v
	}
	out.Order = slices.Clone(q.Order)
	out.GroupBy = slices.Clone(q.GroupBy)
	out.GroupByExpr = slices.Clone(q.GroupByExpr)
	out.Limit, out.IfParent = clonePtr(q.Limit), clonePtr(q.IfParent)
	return out
}

func clonePtr[T any](v *T) *T {
	if v == nil {
		return nil
	}
	c := *v
	return &c
}

func cloneGroup(g *Group) *Group {
	if g == nil {
		return nil
	}
	out := *g
	out.Items = slices.Clone(g.Items)
	for i, item := range g.Items {
		if item.Pred != nil {
			p := *item.Pred
			p.P = clonePtr(p.P)
			p.Ps, p.Match = slices.Clone(p.Ps), slices.Clone(p.Match)
			p.Ref = clonePtr(p.Ref)
			out.Items[i].Pred = &p
		}
		out.Items[i].Group = cloneGroup(item.Group)
		if item.Nav != nil {
			n := *item.Nav
			n.Group = cloneGroup(n.Group)
			out.Items[i].Nav = &n
		}
	}
	return &out
}
