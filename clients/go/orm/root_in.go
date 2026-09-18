package orm

import (
	"fmt"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
)

// rootINParts splits a root IN list that exceeds the driver bind limit into
// requests whose results together equal the original result. Only an IN
// joined to the other root conditions with AND is split, and only when the
// statement has no ordering, range, or grouping that a merge would change.
func rootINParts(r *request, st *plan.Step, driver string) ([]*request, error) {
	limit := driverBindLimit(driver)
	if len(st.BindSlots) <= limit {
		return nil, nil
	}
	q := &r.ir.Query
	tooLarge := &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("the statement needs %d bind parameters but %s permits %d", len(st.BindSlots), driver, limit)}
	if q.Limit != nil || len(q.Order) > 0 || len(q.GroupBy) > 0 || len(q.GroupByExpr) > 0 || q.Where == nil {
		return nil, tooLarge
	}
	target := -1
	for i, item := range q.Where.Items {
		if item.Pred == nil {
			continue
		}
		if item.Pred.Conn == "or" || (i+1 < len(q.Where.Items) && itemConn(q.Where.Items[i+1]) == "or") {
			return nil, tooLarge
		}
		if item.Pred.Op == "in" && item.Pred.Sub == nil && (target < 0 || len(item.Pred.Ps) > len(q.Where.Items[target].Pred.Ps)) {
			target = i
		}
	}
	if target < 0 {
		return nil, tooLarge
	}
	ps := q.Where.Items[target].Pred.Ps
	available := limit - (len(st.BindSlots) - len(ps))
	if available < 1 {
		return nil, tooLarge
	}
	chunk := 1
	for chunk*2 <= available {
		chunk *= 2
	}
	seen := map[string]bool{}
	unique := make([]int, 0, len(ps))
	for _, idx := range ps {
		key := scalarKey(r.params[idx])
		if !seen[key] {
			seen[key] = true
			unique = append(unique, idx)
		}
	}
	var parts []*request
	for start := 0; start < len(unique); start += chunk {
		end := min(start+chunk, len(unique))
		part := *r
		part.ir.Query = ir.CloneQuery(r.ir.Query)
		part.ir.Query.Where.Items[target].Pred.Ps = padIndexes(unique[start:end])
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

func itemConn(item ir.Item) string {
	switch {
	case item.Pred != nil:
		return item.Pred.Conn
	case item.Group != nil:
		return item.Group.Conn
	case item.Joined != nil:
		return item.Joined.Conn
	}
	return ""
}
