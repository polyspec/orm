package orm

import (
	"testing"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/testcase"
)

func TestShapeIgnoresParamValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	a := &request{}
	b := &request{}
	for _, r := range []*request{a, b} {
		r.ir.Kind = "all"
		r.ir.Entity = "author"
		i := r.param(int64(len(r.params)))
		r.ir.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "eq", P: &i}}}}
	}
	a.params[0], b.params[0] = int64(1), int64(2)
	if shapeKey(&a.ir) != shapeKey(&b.ir) {
		t.Error("different param values must share a shape")
	}
}

// Requirements: INT-143.
func TestPlanIDFixedWidthLowercaseHex(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, tc := range []struct {
		key  uint64
		want string
	}{
		{key: 0, want: "0000000000000000"},
		{key: 0x1f, want: "000000000000001f"},
		{key: ^uint64(0), want: "ffffffffffffffff"},
	} {
		if got := PlanID(tc.key); got != tc.want {
			t.Errorf("PlanID(%#x) = %q, want %q", tc.key, got, tc.want)
		}
	}
}
