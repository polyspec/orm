package orm

import (
	"fmt"
	"slices"

	"github.com/polyspec/orm/packages/go/engine/ir"
)

// splitReadPlan plans a read whose root IN list may be split (PRT-76) and
// returns the number of bind slots its first statement needs. A request with
// more values than the bind limit is planned with its longest root IN list cut
// to its first value, so no plan holds a bind slot per value of the list;
// rootINParts plans the parts, each within the bind limit.
func (d *DB) splitReadPlan(r *request) (*cached, int, error) {
	if !r.canonical {
		if err := canonicalize(r); err != nil {
			return nil, 0, err
		}
	}
	target := -1
	if len(r.params) > driverBindLimit(d.driver) {
		target = rootINTarget(&r.ir.Query)
	}
	if target < 0 {
		c, err := d.plan(r)
		if err != nil {
			return nil, 0, err
		}
		return c, len(c.plan.Steps[0].BindSlots), nil
	}
	ps := r.ir.Where.Items[target].Pred.Ps
	probe := *r
	probe.ir.Query = ir.CloneQuery(r.ir.Query)
	probe.ir.Where.Items[target].Pred.Ps = ps[:1]
	c, err := d.plan(&probe)
	if err != nil {
		return nil, 0, err
	}
	slots := len(c.plan.Steps[0].BindSlots) - 1 + len(ps)
	if slots <= driverBindLimit(d.driver) {
		c, err = d.plan(r)
		if err != nil {
			return nil, 0, err
		}
		slots = len(c.plan.Steps[0].BindSlots)
	}
	return c, slots, nil
}

// rootINTarget is the index of the longest root IN list of values in the
// where items, or -1 when there is none.
func rootINTarget(q *ir.Query) int {
	if q.Where == nil {
		return -1
	}
	target := -1
	for i, item := range q.Where.Items {
		if item.Pred != nil && item.Pred.Op == "in" && item.Pred.Sub == nil && len(item.Pred.Ps) > 0 && (target < 0 || len(item.Pred.Ps) > len(q.Where.Items[target].Pred.Ps)) {
			target = i
		}
	}
	return target
}

// rootINParts splits a root IN list that exceeds the driver bind limit into
// requests whose results together equal the original result. slots is the
// number of bind slots of the whole request (splitReadPlan). Only an IN
// joined to the other root conditions with AND is split, and only when the
// statement has no ordering, range, or grouping that a merge would change.
func rootINParts(r *request, slots int, driver string) ([]*request, error) {
	limit := driverBindLimit(driver)
	if slots <= limit {
		return nil, nil
	}
	q := &r.ir.Query
	tooLarge := &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("the statement needs %d bind parameters but %s permits %d", slots, driver, limit)}
	if q.Limit != nil || len(q.Order) > 0 || len(q.GroupBy) > 0 || q.Where == nil {
		return nil, tooLarge
	}
	for i, item := range q.Where.Items {
		if item.Pred == nil {
			continue
		}
		if item.Pred.Conn == "or" || (i+1 < len(q.Where.Items) && ir.ItemConn(q.Where.Items[i+1]) == "or") {
			return nil, tooLarge
		}
	}
	target := rootINTarget(q)
	if target < 0 {
		return nil, tooLarge
	}
	ps := q.Where.Items[target].Pred.Ps
	available := limit - (slots - len(ps))
	if available < 1 {
		return nil, tooLarge
	}
	chunk := 1
	for chunk*2 <= available {
		chunk *= 2
	}
	seen := map[Key]bool{}
	unique := make([]int, 0, len(ps))
	for _, idx := range ps {
		key, err := KeyOf(r.params[idx])
		if err != nil {
			return nil, err
		}
		if !seen[key] {
			seen[key] = true
			unique = append(unique, idx)
		}
	}
	// Each part clones the query without the split list, so a part does not copy every value of it.
	base := r.ir.Query
	where := *q.Where
	where.Items = slices.Clone(q.Where.Items)
	base.Where = &where
	pred := *q.Where.Items[target].Pred
	pred.Ps = nil
	base.Where.Items[target].Pred = &pred
	var parts []*request
	for start := 0; start < len(unique); start += chunk {
		end := min(start+chunk, len(unique))
		part := *r
		part.ir.Query = ir.CloneQuery(base)
		part.ir.Where.Items[target].Pred.Ps = padIndexes(unique[start:end])
		parts = append(parts, &part)
	}
	return parts, nil
}

func padIndexes(ps []int) []int {
	n := 1
	for n < len(ps) {
		n <<= 1
	}
	out := make([]int, n)
	copy(out, ps)
	for i := len(ps); i < n; i++ {
		out[i] = ps[len(ps)-1]
	}
	return out
}

func driverBindLimit(driver string) int {
	if driver == "sqlite" {
		return 999
	}
	return 65535
}
