package orm

import "testing"

func TestNewQAllowsConfigurationBeforeBinding(t *testing.T) {
	q := NewQ(nil, "example")
	q.Set("name", "configured")
	q.W().Pred("id", "eq", "id-1")

	if len(q.Req.Params) != 2 {
		t.Fatalf("parameters=%d, want 2", len(q.Req.Params))
	}
	if len(q.Req.IR.Set) != 1 || q.Req.IR.Set[0].Column != "name" {
		t.Fatalf("assignments=%#v", q.Req.IR.Set)
	}
	if q.Req.IR.Query.Where == nil {
		t.Fatal("predicate was not recorded")
	}
}
