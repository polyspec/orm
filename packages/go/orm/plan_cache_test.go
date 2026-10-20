package orm

import (
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestPlanCacheBoundedByInListShape runs one IN statement with lists of 1 to
// 300 values. The plan cache holds one entry per statement shape with the list
// length bucketed to a power of two, so the entry count stays at most the number
// of buckets (1, 2, 4 ... 512: ten), not one per length.
// Requirements: CPX-4.
func TestPlanCacheBoundedByInListShape(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m, err := runtimemodel.LoadFiles("../../../contracts/fixtures/identity_load.dbs")
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	d := &DB{
		cfg:    Config{PlanCacheSize: 1024},
		driver: "sqlite",
		m: &dbMutable{
			engines: map[string]*engine.Engine{m.ManifestHash: eng},
			schemas: map[string]*Schema{},
		},
		plans: map[uint64]*cached{},
	}
	schema := &Schema{Hash: m.ManifestHash, Text: m.ManifestText}
	const bound = 10
	for n := 1; n <= 300; n++ {
		params := make([]any, n)
		ps := make([]int, n)
		for i := range ps {
			params[i] = int64(i)
			ps[i] = i
		}
		r := &request{
			ir:     ir.Request{IRVersion: 1, ManifestHash: m.ManifestHash, Kind: "all", Query: ir.Query{Entity: "load_probe", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "in", Ps: ps}}}}}},
			schema: schema,
			params: params,
		}
		if _, err := d.plan(r); err != nil {
			t.Fatalf("length %d: plan failed: %v", n, err)
		}
		if got := len(d.plans); got > bound {
			t.Fatalf("length %d: plan cache holds %d entries, want at most %d (one per bucketed shape)", n, got, bound)
		}
	}
}

// TestCanonicalizePadsInListAndRejectsOutOfRangeParam checks the rewrite of
// one IN list: its slots repeat the last value up to the bucket, the
// parameters follow the walk, and an index past the parameters is IR_INVALID.
// Requirements: CPX-4.
func TestCanonicalizePadsInListAndRejectsOutOfRangeParam(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	in := func(ps ...int) *request {
		params := make([]any, 0, len(ps)+1)
		for i := range ps {
			params = append(params, int64(10+i))
		}
		params = append(params, "tail")
		return &request{
			ir:     ir.Request{Kind: "all", Query: ir.Query{Entity: "load_probe", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "in", Ps: ps}}}}}},
			params: params,
		}
	}
	r := in(0, 1, 2)
	r.ir.Where.Items[0].Pred.Ps = []int{0, 1, 2}
	if err := canonicalize(r); err != nil {
		t.Fatal(err)
	}
	if got := r.ir.Where.Items[0].Pred.Ps; !slices.Equal(got, []int{0, 1, 2, 3}) {
		t.Fatalf("padded list = %v, want slots 0 to 3", got)
	}
	if want := []any{int64(10), int64(11), int64(12), int64(12), "tail"}; len(r.params) != len(want) || r.params[3] != want[3] || r.params[4] != want[4] {
		t.Fatalf("canonical params = %#v, want %#v", r.params, want)
	}
	if r.ir.NParams != 5 || !r.canonical {
		t.Fatalf("NParams = %d, canonical = %v", r.ir.NParams, r.canonical)
	}
	bad := in(0)
	bad.ir.Where.Items[0].Pred.Ps = []int{7}
	if err := canonicalize(bad); ErrorCode(err) != "IR_INVALID" {
		t.Fatalf("out-of-range param error = %v, want IR_INVALID", err)
	}
}
