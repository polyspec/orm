package orm

import (
	"fmt"
	"reflect"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
)

// rootINParts creates requests for a root IN predicate that would exceed the
// driver's bind limit. It keeps the original parameter indexes so transforms,
// encryption, and event masking remain unchanged.
func rootINParts(r *Req, st *plan.Step, driver string) ([]*Req, error) {
	limit := driverBindLimit(driver)
	if len(st.BindSlots) > limit && (r.IR.Query.Limit != nil || len(r.IR.Query.Order) > 0 || r.IR.Query.Distinct || len(r.IR.Query.GroupBy) > 0 || len(r.IR.Query.GroupByExpr) > 0 || r.IR.Query.Having != nil || r.IR.Query.Keyset != nil) {
		return nil, &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("root query requires %d bind parameters but %s permits %d; root IN cannot be split with ordering, limiting, grouping, distinct, or keyset semantics", len(st.BindSlots), driver, limit)}
	}
	var candidates []*ir.Pred
	collectINPreds(r.IR.Query.Where, &candidates)
	if len(candidates) == 0 {
		return nil, nil
	}
	var target *ir.Pred
	targetOrdinal := -1
	for ordinal, p := range candidates {
		if p.Op == "not_in" {
			if len(st.BindSlots) > limit {
				return nil, &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("root NOT IN requires %d bind parameters but %s permits %d; NOT IN is not split because independent queries cannot preserve exclusion semantics", len(st.BindSlots), driver, limit)}
			}
			continue
		}
		if p.Op == "in" && len(st.BindSlots) > limit && (target == nil || len(p.Ps) > len(target.Ps)) {
			target = p
			targetOrdinal = ordinal
		}
	}
	if target == nil {
		return nil, nil
	}
	available := limit - (len(st.BindSlots) - len(target.Ps))
	if available < 1 {
		return nil, &ir.Error{Code: CodeIrInvalid, Msg: fmt.Sprintf("root IN requires at least one list bind but %s permits %d total bind parameters", driver, limit)}
	}
	chunkSize := 1
	for chunkSize*2 <= available {
		chunkSize *= 2
	}
	indexes := uniqueParamIndexes(r, target.Ps)
	parts := make([]*Req, 0, (len(indexes)+chunkSize-1)/chunkSize)
	for start := 0; start < len(indexes); start += chunkSize {
		end := start + chunkSize
		if end > len(indexes) {
			end = len(indexes)
		}
		part := &Req{IR: r.IR, Params: r.Params, Err: r.Err}
		part.IR.Query = ir.CloneQuery(r.IR.Query)
		if !replaceINPredOrdinal(part.IR.Query.Where, targetOrdinal, indexes[start:end]) {
			return nil, &ir.Error{Code: CodeInternal, Msg: "root IN split target disappeared while cloning request"}
		}
		parts = append(parts, part)
	}
	return parts, nil
}

func driverBindLimit(driver string) int {
	if driver == "sqlite" {
		return 999
	}
	return 65535
}

func collectINPreds(g *ir.Group, out *[]*ir.Pred) {
	if g == nil {
		return
	}
	for i := range g.Items {
		if g.Items[i].Pred != nil {
			p := g.Items[i].Pred
			if p.Op == "in" || p.Op == "not_in" {
				*out = append(*out, p)
			}
		}
		collectINPreds(g.Items[i].Group, out)
		if g.Items[i].Nav != nil {
			collectINPreds(g.Items[i].Nav.Group, out)
		}
	}
}

func replaceINPredOrdinal(g *ir.Group, targetOrdinal int, indexes []int) bool {
	ordinal := 0
	return replaceINPredOrdinalAt(g, targetOrdinal, &ordinal, indexes)
}

func replaceINPredOrdinalAt(g *ir.Group, targetOrdinal int, ordinal *int, indexes []int) bool {
	if g == nil {
		return false
	}
	for i := range g.Items {
		if g.Items[i].Pred != nil && (g.Items[i].Pred.Op == "in" || g.Items[i].Pred.Op == "not_in") {
			if *ordinal == targetOrdinal {
				g.Items[i].Pred.Ps = append([]int(nil), indexes...)
				return true
			}
			(*ordinal)++
		}
		if replaceINPredOrdinalAt(g.Items[i].Group, targetOrdinal, ordinal, indexes) {
			return true
		}
		if g.Items[i].Nav != nil && replaceINPredOrdinalAt(g.Items[i].Nav.Group, targetOrdinal, ordinal, indexes) {
			return true
		}
	}
	return false
}

func uniqueParamIndexes(r *Req, indexes []int) []int {
	out := make([]int, 0, len(indexes))
	for _, idx := range indexes {
		duplicate := false
		for _, prior := range out {
			if reflect.DeepEqual(r.Params[idx], r.Params[prior]) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			out = append(out, idx)
		}
	}
	return out
}
