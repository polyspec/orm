// Package irwhere narrows the where of an IR query, as the request hooks of the tests and of the recipe helper do.
package irwhere

import "github.com/polyspec/orm/packages/go/engine/ir"

// And adds pred to the where of q with and; an existing where is wrapped in one group item.
func And(q *ir.Query, pred ir.Pred) {
	if q.Where == nil || len(q.Where.Items) == 0 {
		q.Where = &ir.Group{Items: []ir.Item{{Pred: &pred}}}
		return
	}
	pred.Conn = "and"
	q.Where = &ir.Group{Items: []ir.Item{{Group: q.Where}, {Pred: &pred}}}
}
