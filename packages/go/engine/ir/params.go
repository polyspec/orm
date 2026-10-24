package ir

import (
	"github.com/polyspec/orm/packages/go/engine/dialect"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
)

// ParamUse is one slot that a request parameter fills: the slot's logical type,
// a dbspec type kind, and for a column slot the compared or assigned column with
// its precision, scale, length and nullability.
type ParamUse struct {
	Type   string
	Column *runtimemodel.Field
	// Assign marks the assignment of Column (set, rows, on_duplicate): a non-null column
	// refuses NULL.
	Assign bool
}

// ParamUses lists the uses of each parameter of a validated request, by
// parameter index: the compared or assigned column; a column function's result;
// i32, or f64 for seconds, for the interval of a relative time function; text
// for contains and contains_binary; the parent column for if_parent; the column
// for optimistic. An IR executor message writes each parameter in the form of
// its slot's type (docs/spec/protocol.md §5), so the client reads the type here.
func ParamUses(m *runtimemodel.Model, r *Request) ([][]ParamUse, error) {
	u := &paramUses{m: m, out: make([][]ParamUse, r.NParams)}
	ent := m.Entities[r.Entity]
	if err := u.query(&r.Query, nil); err != nil {
		return nil, err
	}
	for _, a := range r.Set {
		u.assign(ent, a)
	}
	for _, a := range r.OnDuplicate {
		u.assign(ent, a)
	}
	for _, row := range r.Rows {
		for j, i := range row {
			u.assigned(i, ent.Field(r.Set[j].Column))
		}
	}
	if o := r.Optimistic; o != nil {
		u.column(o.P, ent.Field(o.Column))
	}
	return u.out, nil
}

type paramUses struct {
	m   *runtimemodel.Model
	out [][]ParamUse
}

func (u *paramUses) add(i int, use ParamUse) {
	if i >= 0 && i < len(u.out) {
		u.out[i] = append(u.out[i], use)
	}
}

func (u *paramUses) column(i int, f *runtimemodel.Field) {
	if f != nil {
		u.add(i, ParamUse{Type: f.Type, Column: f})
	}
}

func (u *paramUses) assign(ent *runtimemodel.Entity, a Assign) {
	f := ent.Field(a.Column)
	for _, p := range []*int{a.PlusP, a.MinusP} {
		if p != nil {
			u.column(*p, f)
		}
	}
	if a.P != nil {
		u.assigned(*a.P, f)
	}
}

func (u *paramUses) assigned(i int, f *runtimemodel.Field) {
	if f != nil {
		u.add(i, ParamUse{Type: f.Type, Column: f, Assign: true})
	}
}

// query walks q, whose parent entity is parent for a relation child.
func (u *paramUses) query(q *Query, parent *runtimemodel.Entity) error {
	ent := u.m.Entities[q.Entity]
	if ent == nil {
		return nil
	}
	if err := u.group(q.On, ent); err != nil {
		return err
	}
	if err := u.group(q.Where, ent); err != nil {
		return err
	}
	if q.IfParent != nil && parent != nil {
		u.column(q.IfParent.P, parent.Field(q.IfParent.Column))
	}
	if q.Columns != nil {
		for _, s := range q.Columns.Sub {
			if err := u.query(s.Query, nil); err != nil {
				return err
			}
		}
	}
	for _, j := range q.Joins {
		if err := u.query(j.Query, nil); err != nil {
			return err
		}
	}
	for _, rel := range q.Relations {
		if err := u.query(rel.Query, ent); err != nil {
			return err
		}
	}
	return nil
}

func (u *paramUses) group(g *Group, ent *runtimemodel.Entity) error {
	if g == nil {
		return nil
	}
	for _, item := range g.Items {
		switch {
		case item.Pred != nil:
			if err := u.pred(item.Pred, ent); err != nil {
				return err
			}
		case item.Group != nil:
			if err := u.group(item.Group, ent); err != nil {
				return err
			}
		}
	}
	return nil
}

func (u *paramUses) pred(p *Pred, ent *runtimemodel.Entity) error {
	if p.Sub != nil {
		if err := u.query(p.Sub.Query, nil); err != nil {
			return err
		}
	}
	if p.Op == "tuple_in" || p.Op == "tuple_not_in" {
		for k, i := range p.Ps {
			if len(p.Cols) > 0 {
				u.column(i, ent.Field(p.Cols[k%len(p.Cols)]))
			}
		}
		return nil
	}
	if p.Op == "fulltext" || p.Op == "fulltext_boolean" {
		if p.P != nil {
			u.add(*p.P, ParamUse{Type: "text"})
		}
		return nil
	}
	f := ent.Field(p.Column)
	if p.Value != nil {
		for _, i := range p.Value.Ps {
			u.add(i, ParamUse{Type: IntervalType(p.Value.Name)})
		}
	}
	if p.Op == "contains" || p.Op == "contains_binary" {
		if p.P != nil {
			u.add(*p.P, ParamUse{Type: "text"})
		}
		return nil
	}
	slots := p.Ps
	if p.P != nil {
		slots = append([]int{*p.P}, slots...)
	}
	for _, i := range slots {
		if p.Fn != nil {
			t, ok := FunctionType(p.Fn.Name, f)
			if !ok {
				return &Error{Code: "INTERNAL", Msg: ent.Name + "." + p.Column + " is missing from validated column-function metadata"}
			}
			if f != nil && t == f.Type {
				u.column(i, f)
			} else {
				u.add(i, ParamUse{Type: t})
			}
			continue
		}
		u.column(i, f)
	}
	return nil
}

// FunctionType is the type of a column function's result on column f: the type
// of a parameter compared with it and of the output column it selects.
func FunctionType(name string, f *runtimemodel.Field) (string, bool) {
	if f == nil {
		return "", false
	}
	switch name {
	case "day_of_week", "year", "month":
		return "i64", true
	case "date":
		return "date", true
	}
	return f.Type, true
}

// IntervalType is the type of the interval of a relative time function: seconds
// take a fraction, the other units an integer.
func IntervalType(name string) string {
	if dialect.ValueFunctionUnits[name] == "second" {
		return "f64"
	}
	return "i32"
}
