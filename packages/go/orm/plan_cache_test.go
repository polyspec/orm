package orm

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/packages/go/engine"
	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/runtimemodel"
	"github.com/polyspec/orm/packages/go/testcase"
)

func planCacheIdentityLoadFixture(t *testing.T) (*runtimemodel.Model, *Schema) {
	t.Helper()
	m, err := runtimemodel.LoadFiles("../../../contracts/fixtures/identity_load.dbs")
	if err != nil {
		t.Fatal(err)
	}
	return m, &Schema{Hash: m.ManifestHash, Text: m.ManifestText}
}

func TestPadInRepeatsTheLastCompositeTuple(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	rows := [][]any{{int64(990004), int64(1)}, {int64(990004), int64(2)}, {int64(990004), int64(3)}}
	got := padIn(rows)
	want := [][]any{{int64(990004), int64(1)}, {int64(990004), int64(2)}, {int64(990004), int64(3)}, {int64(990004), int64(3)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("padded composite tuples = %#v, want %#v", got, want)
	}
	if len(rows) != 3 || !reflect.DeepEqual(rows[2], []any{int64(990004), int64(3)}) {
		t.Fatalf("padding changed the caller's tuples: %#v", rows)
	}
}

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

// TestInListPaddingKeepsTheCompiledShape checks that 3 and 4 values in one bucket
// produce the same canonical IR, bind order, and SQL shape.
// Requirements: CPX-4.
func TestInListPaddingKeepsTheCompiledShape(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m, schema := planCacheIdentityLoadFixture(t)
	makeRequest := func(values []any) *request {
		ps := make([]int, len(values)-1)
		for i := range ps {
			ps[i] = i
		}
		followingParam := len(values) - 1
		return &request{
			ir: ir.Request{
				IRVersion: 1, ManifestHash: m.ManifestHash, Kind: "all", NParams: len(values),
				Query: ir.Query{Entity: "load_probe", Where: &ir.Group{Items: []ir.Item{
					{Pred: &ir.Pred{Column: "seq", Op: "in", Ps: ps}},
					{Pred: &ir.Pred{Column: "label", Op: "eq", P: &followingParam}},
				}}},
			},
			params: values,
			schema: schema,
		}
	}
	inputs := [][]any{{"a", "b", "c", "tail"}, {"a", "b", "c", "d", "tail"}}
	for _, dialect := range []string{"mysql", "postgres", "sqlite"} {
		eng, err := engine.New(m, dialect)
		if err != nil {
			t.Fatal(err)
		}
		var firstSQL string
		for i, values := range inputs {
			r := makeRequest(values)
			if err := canonicalize(r); err != nil {
				t.Fatalf("%s input %d: canonicalize: %v", dialect, i, err)
			}
			predicates := r.ir.Where.Items
			if got, want := predicates[0].Pred.Ps, []int{0, 1, 2, 3}; !slices.Equal(got, want) {
				t.Fatalf("%s input %d IN indexes = %v, want %v", dialect, i, got, want)
			}
			if got := *predicates[1].Pred.P; got != 4 {
				t.Fatalf("%s input %d following parameter = %d, want 4", dialect, i, got)
			}
			wantParams := []any{"a", "b", "c", "c", "tail"}
			if i == 1 {
				wantParams[3] = "d"
			}
			if !reflect.DeepEqual(r.params, wantParams) || r.ir.NParams != 5 {
				t.Fatalf("%s input %d canonical values = %#v, n_params %d; want %#v, 5", dialect, i, r.params, r.ir.NParams, wantParams)
			}
			compiled, err := eng.P.Compile(&r.ir)
			if err != nil {
				t.Fatalf("%s input %d: compile: %v", dialect, i, err)
			}
			step := compiled.Steps[0]
			var params []int
			for _, slot := range step.BindSlots {
				params = append(params, slot.Param)
			}
			if !slices.Equal(params, []int{0, 1, 2, 3, 4}) {
				t.Fatalf("%s input %d bind slots = %v, want [0 1 2 3 4]", dialect, i, params)
			}
			if i == 0 {
				firstSQL = step.SQL
			} else if step.SQL != firstSQL {
				t.Fatalf("%s compiled SQL changed within bucket: %q != %q", dialect, step.SQL, firstSQL)
			}
		}
	}
}

// Requirements: PRT-78; T236.
func TestPlanCachePagedReadBindsPageValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	m, schema := planCacheIdentityLoadFixture(t)
	for _, driver := range []string{"mysql", "postgres", "sqlite"} {
		eng, err := engine.New(m, driver)
		if err != nil {
			t.Fatal(err)
		}
		d := &DB{
			cfg: Config{PlanCacheSize: 1024}, driver: driver,
			m:     &dbMutable{engines: map[string]*engine.Engine{m.ManifestHash: eng}, schemas: map[string]*Schema{}},
			plans: map[uint64]*cached{},
		}
		for page := 0; page < 300; page++ {
			r := &request{
				ir: ir.Request{IRVersion: 1, ManifestHash: m.ManifestHash, Kind: "all", NParams: 1,
					Query: ir.Query{Entity: "load_probe", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "eq", P: pageParamIndex(0)}}}}, Limit: &ir.Limit{Offset: page * 20, Count: 20}}},
				schema: schema, params: []any{"where"},
			}
			c, err := d.plan(r)
			if err != nil {
				t.Fatalf("%s page %d: %v", driver, page, err)
			}
			if got, want := r.params, []any{"where", int64(page * 20), int64(20)}; !reflect.DeepEqual(got, want) {
				t.Fatalf("%s page %d params = %#v, want %#v", driver, page, got, want)
			}
			if got := len(d.plans); got != 1 {
				t.Fatalf("%s page %d has %d cache entries, want one", driver, page, got)
			}
			step := c.plan.Steps[0]
			wantParams := []int{0, 1, 2}
			if driver != "mysql" {
				wantParams = []int{0, 2, 1}
			}
			gotParams := make([]int, len(step.BindSlots))
			for i, slot := range step.BindSlots {
				gotParams[i] = slot.Param
				if slot.ColType != "i64" && i > 0 {
					t.Fatalf("%s page bind %d type = %s, want i64", driver, i, slot.ColType)
				}
			}
			if !slices.Equal(gotParams, wantParams) {
				t.Fatalf("%s bind params = %v, want %v", driver, gotParams, wantParams)
			}
			if !strings.Contains(step.SQL, " LIMIT ") {
				t.Fatalf("%s SQL has no page limit: %s", driver, step.SQL)
			}
		}
		for _, test := range []struct {
			name  string
			value any
			code  string
		}{
			{name: "wrong type", value: false, code: "CODEC_ENCODE"},
			{name: "unsafe integer", value: int64(9007199254740992), code: "CODEC_ENCODE"},
			{name: "negative offset", value: int64(-1), code: "IR_INVALID"},
		} {
			bad := &request{
				ir: ir.Request{IRVersion: 1, ManifestHash: m.ManifestHash, Kind: "all", NParams: 3,
					Query: ir.Query{Entity: "load_probe", Where: &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Column: "seq", Op: "eq", P: pageParamIndex(0)}}}}, Limit: &ir.Limit{OffsetP: pageParamIndex(1), CountP: pageParamIndex(2)}}},
				schema: schema, params: []any{"where", test.value, int64(20)}, canonical: true,
			}
			if _, err := d.plan(bad); ErrorCode(err) != test.code {
				t.Fatalf("%s warm-cache invalid page error = %v, want %s", test.name, err, test.code)
			}
		}
	}
}

func pageParamIndex(value int) *int { return &value }

// compositeVector is the shared plan cache key vector of contracts/fixtures/plan_cache_composite.json.
type compositeVector struct {
	Request   ir.Request `json:"request"`
	Params    []any      `json:"params"`
	Canonical struct {
		Params       []any    `json:"params"`
		NParams      int      `json:"n_params"`
		Limit        ir.Limit `json:"limit"`
		IfParentP    int      `json:"if_parent_p"`
		SetP         []int    `json:"set_p"`
		OnDuplicateP []int    `json:"on_duplicate_p"`
		Rows         [][]int  `json:"rows"`
		OptimisticP  int      `json:"optimistic_p"`
	} `json:"canonical"`
}

// Requirements: CPX-4.
func TestCanonicalizeCompositeRequestParameterWalk(t *testing.T) {
	t.Run("plan_cache_composite_parameter_order", func(t *testing.T) {
		testcase.Start(t, testcase.Compute)
		raw, err := os.ReadFile("../../../contracts/fixtures/plan_cache_composite.json")
		if err != nil {
			t.Fatal(err)
		}
		var v compositeVector
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		request := &request{ir: v.Request, params: v.Params}
		if err := canonicalize(request); err != nil {
			t.Fatal(err)
		}
		want := make([]any, len(v.Canonical.Params))
		for i, p := range v.Canonical.Params {
			if f, ok := p.(float64); ok {
				want[i] = int64(f)
			} else {
				want[i] = p
			}
		}
		if !reflect.DeepEqual(request.params, want) {
			t.Fatalf("canonical params = %#v, want %#v", request.params, want)
		}
		got := request.ir
		if request.ir.NParams != v.Canonical.NParams {
			t.Fatalf("canonical n_params = %d, want %d", got.NParams, v.Canonical.NParams)
		}
		if got.Limit == nil || got.Limit.OffsetP == nil || *got.Limit.OffsetP != *v.Canonical.Limit.OffsetP || got.Limit.CountP == nil || *got.Limit.CountP != *v.Canonical.Limit.CountP {
			t.Fatalf("canonical limit = %#v, want %#v", got.Limit, v.Canonical.Limit)
		}
		if got.IfParent.P != v.Canonical.IfParentP || *got.Set[0].P != v.Canonical.SetP[0] || *got.OnDuplicate[0].P != v.Canonical.OnDuplicateP[0] || got.Rows[0][0] != v.Canonical.Rows[0][0] || got.Optimistic.P != v.Canonical.OptimisticP {
			t.Fatalf("request parameter fields were not renumbered by the walk: %#v", got)
		}
	})
	t.Run("plan_cache_predicate_fn_parameter_order", func(t *testing.T) {
		testcase.Start(t, testcase.Compute)
		raw, err := os.ReadFile("../../../contracts/fixtures/plan_cache_composite.json")
		if err != nil {
			t.Fatal(err)
		}
		var all struct {
			Vector compositeVector `json:"predicate_fn_param"`
		}
		if err := json.Unmarshal(raw, &all); err != nil {
			t.Fatal(err)
		}
		request := &request{ir: all.Vector.Request, params: all.Vector.Params}
		if err := canonicalize(request); err != nil {
			t.Fatal(err)
		}
		if got, want := request.params, []any{"v1", "v0"}; !slices.Equal(got, want) {
			t.Fatalf("canonical params = %v, want %v", got, want)
		}
		pred := request.ir.Query.Where.Items[0].Pred
		if *pred.P != 0 || pred.Fn.Ps[0] != 1 {
			t.Fatalf("predicate slots p=%d fn.ps=%v, want p=0 fn.ps=[1]", *pred.P, pred.Fn.Ps)
		}
	})
}
