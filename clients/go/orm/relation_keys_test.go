package orm

import (
	"reflect"
	"testing"

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

func TestCompositeRowKeyHasNoConcatenationCollision(t *testing.T) {
	refs := []plan.KeyRef{{Index: 0}, {Index: 1}}
	a, _ := KeyFromRow([]any{"1", "23"}, refs)
	b, _ := KeyFromRow([]any{"12", "3"}, refs)
	if a == b {
		t.Fatalf("different tuples produced the same key: %q", a.String())
	}
}
