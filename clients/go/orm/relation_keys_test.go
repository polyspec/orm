package orm

import (
	"reflect"
	"testing"

	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
)

func TestCompositeParentValuesAreDistinctOrderedTuples(t *testing.T) {
	ref := &plan.ParentRef{Keys: []plan.KeyRef{{Column: "tenant_id", Index: 0}, {Column: "account_id", Index: 1}}}
	rows := [][]any{{int64(1), int64(2)}, {int64(1), int64(3)}, {int64(1), int64(2)}, {int64(2), nil}}
	got := parentValues(ref, rows, nil)
	want := []any{int64(1), int64(2), int64(1), int64(3)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parent tuples = %#v, want %#v", got, want)
	}
}

func TestCompositeParentExpansionPreservesTupleBoundaries(t *testing.T) {
	parent := &plan.ParentRef{Keys: []plan.KeyRef{{Column: "tenant_id"}, {Column: "account_id"}}}
	values := []any{1, 2, 1, 3, 2, 4}
	tests := []struct{ sql, want string }{
		{"SELECT 1 WHERE (a,b) IN ((?)) AND c = ?", "SELECT 1 WHERE (a,b) IN ((?, ?), (?, ?), (?, ?), (?, ?)) AND c = ?"},
		{"SELECT 1 WHERE (a,b) IN (($1)) AND c = $2", "SELECT 1 WHERE (a,b) IN (($1, $2), ($3, $4), ($5, $6), ($7, $8)) AND c = $9"},
	}
	for _, test := range tests {
		step := &plan.Step{SQL: test.sql, Parent: parent, BindSlots: []plan.BindSlot{{From: "parent"}, {From: "param"}}}
		gotSQL, gotValues := expandIn(step, values)
		if gotSQL != test.want {
			t.Errorf("expanded SQL\n got: %s\nwant: %s", gotSQL, test.want)
		}
		wantValues := []any{1, 2, 1, 3, 2, 4, 2, 4}
		if !reflect.DeepEqual(gotValues, wantValues) {
			t.Errorf("expanded values = %#v, want %#v", gotValues, wantValues)
		}
	}
}

func TestRelationChunksStayWithinDriverParameterLimits(t *testing.T) {
	step := &plan.Step{ID: 7, Parent: &plan.ParentRef{Keys: []plan.KeyRef{{Column: "tenant_id"}, {Column: "id"}}}, BindSlots: []plan.BindSlot{{From: "parent"}, {From: "param"}}}
	values := make([]any, 0, 1200)
	for i := 0; i < 600; i++ {
		values = append(values, int64(1), int64(i))
	}
	chunks, err := relationChunks(step, values, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if len(chunks) != 3 {
		t.Fatalf("chunks=%d, want 3", len(chunks))
	}
	for _, chunk := range chunks {
		if len(chunk) > 512 {
			t.Fatalf("chunk has %d values, exceeds padded SQLite limit", len(chunk))
		}
	}
	if got := chunks[0][0]; got != int64(1) {
		t.Fatalf("first chunk order changed: %v", got)
	}
	if got := chunks[len(chunks)-1][len(chunks[len(chunks)-1])-1]; got != int64(599) {
		t.Fatalf("last chunk order changed: %v", got)
	}
}

func TestRootINPartsRespectSQLiteBindLimitAndDeduplicateValues(t *testing.T) {
	eng, err := engine.LoadJSON(mustSchemaJSON(t), "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	r := NewReq(eng, "all", "battle")
	where := &ir.Group{}
	r.IR.Query.Where = where
	w := NewW(r, where)
	values := make([]any, 1000)
	for i := range values {
		values[i] = int64(i)
	}
	values[len(values)-1] = values[0]
	ps := make([]int, 0, len(values))
	for _, value := range values {
		ps = append(ps, r.P(value))
	}
	// The builder normally creates this predicate. Keep the explicit IR here
	// so the test checks the executor's runtime split boundary directly.
	w.G.Items = append(w.G.Items, ir.Item{Pred: &ir.Pred{Column: "seq", Op: "in", Ps: ps}})
	st := &plan.Step{BindSlots: make([]plan.BindSlot, len(ps))}
	for i := range st.BindSlots {
		st.BindSlots[i] = plan.BindSlot{From: "param", Param: i}
	}
	parts, err := rootINParts(r, st, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if len(parts) != 2 {
		t.Fatalf("parts=%d, want 2", len(parts))
	}
	if got := len(parts[0].IR.Query.Where.Items[0].Pred.Ps); got != 512 {
		t.Fatalf("first part binds=%d, want 512", got)
	}
	if got := len(parts[1].IR.Query.Where.Items[0].Pred.Ps); got != 487 {
		t.Fatalf("second part binds=%d, want 487 after duplicate removal", got)
	}
}

func TestCompositeRowKeyHasNoConcatenationCollision(t *testing.T) {
	refs := []plan.KeyRef{{Index: 0}, {Index: 1}}
	a, _ := KeyFromRow([]any{"1", "23"}, refs)
	b, _ := KeyFromRow([]any{"12", "3"}, refs)
	if a == b {
		t.Fatalf("different tuples produced the same key: %q", a.String())
	}
}
