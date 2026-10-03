package orm

import (
	"fmt"
	"math"
	"testing"
	"time"

	"github.com/polyspec/orm/engine/ir"
	"github.com/polyspec/orm/engine/plan"
	"github.com/polyspec/orm/internal/testcase"
)

func TestTypedKeyValuesCannotCollide(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, pair := range [][2]any{
		{int64(1), "1"},
		{true, int64(1)},
		{false, int64(0)},
		{[]byte("a"), "a"},
	} {
		left, leftErr := KeyOf(pair[0])
		right, rightErr := KeyOf(pair[1])
		if leftErr != nil || rightErr != nil {
			t.Fatalf("supported key values: %v, %v", leftErr, rightErr)
		}
		if left == right {
			t.Errorf("distinct values have the same key: %T %v and %T %v", pair[0], pair[0], pair[1], pair[1])
		}
	}
}

func TestUnsupportedKeyIsAnError(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, value := range []any{nil, []byte(nil), struct{ Name string }{"a"}, uint64(math.MaxUint64), math.NaN()} {
		if _, err := KeyOf(value); err == nil {
			t.Errorf("unsupported key %T %v was accepted", value, value)
		}
	}
}

func TestScalarComparisonPreservesTypesAndRejectsInvalidValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, pair := range [][2]any{{true, int64(1)}, {"1", int64(1)}, {[]byte("a"), "a"}} {
		match, err := SameScalar(pair[0], pair[1])
		if err != nil || match {
			t.Errorf("distinct scalars compared equal: %v %v: %v", pair[0], pair[1], err)
		}
	}
	if match, err := SameScalar(int(7), int64(7)); err != nil || !match {
		t.Fatalf("equal integers: %v %v", match, err)
	}
	if _, err := SameScalar(nil, struct{}{}); err == nil {
		t.Fatal("invalid value beside NULL was ignored")
	}
}

func TestKeyValuesPreserveTheirTypes(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	instant := time.Date(2026, 1, 2, 3, 4, 5, 6, time.UTC)
	for _, value := range []any{int64(7), true, "text", []byte("bytes"), float64(1.25), instant} {
		key, err := KeyOf(value)
		if err != nil {
			t.Fatal(err)
		}
		got, err := key.Value()
		if err != nil {
			t.Fatal(err)
		}
		if fmt.Sprintf("%T:%v", got, got) != fmt.Sprintf("%T:%v", value, value) {
			t.Errorf("value type changed: %T %v => %T %v", value, value, got, got)
		}
	}
	if _, err := (Key{}).Value(); err == nil {
		t.Fatal("zero key returned a plausible value")
	}
}

func TestSelectedByteKeyPreservesByteType(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	values := []any{"\xff\x00"}
	step := &plan.Step{Assemble: &plan.Assemble{Columns: []plan.OutCol{{Index: 0, Name: "payload", Type: "bytes"}}}}
	if err := decodeSelectedRow(values, &scanInfo{}, step, AESKeyring{}); err != nil {
		t.Fatal(err)
	}
	key, present, err := keyFromRow(values, []plan.KeyRef{{Index: 0}})
	if err != nil || !present {
		t.Fatalf("byte row key: %v %v", present, err)
	}
	want, err := KeyOf([]byte{0xff, 0})
	if err != nil {
		t.Fatal(err)
	}
	if key != want {
		t.Fatalf("byte row key became %T: got %v, want %v", values[0], key, want)
	}
}

func TestJoinedByteColumnsAndInvalidValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	child := &plan.Assemble{Columns: []plan.OutCol{{Index: 1, Name: "child_bytes", Type: "bytes"}}}
	root := &plan.Assemble{Columns: []plan.OutCol{{Index: 0, Name: "id", Type: "i64"}}, Children: []*plan.Child{{Kind: "join", Assemble: child}}}
	values := []any{int64(1), "\x00\xff"}
	if err := restoreByteColumns(values, root); err != nil {
		t.Fatal(err)
	}
	if got, ok := values[1].([]byte); !ok || len(got) != 2 || got[0] != 0 || got[1] != 0xff {
		t.Fatalf("joined byte column changed: %T %v", values[1], values[1])
	}
	values[1] = int64(7)
	if err := restoreByteColumns(values, root); err == nil {
		t.Fatal("invalid byte column was accepted")
	}
}

func TestCompositeTypedKeyPreservesBoundaries(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	for _, pair := range [][2][]any{
		{{"1", "23"}, {"12", "3"}},
		{{int64(1), "2"}, {"1", "2"}},
		{{true, "2"}, {int64(1), "2"}},
	} {
		left, leftErr := keyFromValues(pair[0])
		right, rightErr := keyFromValues(pair[1])
		if leftErr != nil || rightErr != nil {
			t.Fatalf("valid composite values: %v, %v", leftErr, rightErr)
		}
		if left == right {
			t.Errorf("distinct composite values have the same key: %v and %v", pair[0], pair[1])
		}
	}
}

func TestCollectionLookupRejectsUnsupportedKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	collection := NewCollection[*rejectingModel]()
	value := struct{ ID int }{1}
	if _, err := collection.Get(value); err == nil {
		t.Fatal("Get accepted unsupported key")
	}
	if _, err := collection.Has(value); err == nil {
		t.Fatal("Has accepted unsupported key")
	}
	if _, err := collection.FetchedValue(value); err == nil {
		t.Fatal("FetchedValue accepted unsupported key")
	}
}

func TestModelCollectionKeyRejectsInvalidCallbackAndMissingColumn(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	core := NewCore(nil)
	core.fetchKey = func(Model) any { return struct{}{} }
	if _, err := core.collectionKey(&Core{self: &rejectingModel{}}, nil, nil); err == nil {
		t.Fatal("invalid fetch key callback result was accepted")
	}
	core = NewCore(&Entity{Value: func(Model, string) (any, bool) { return nil, false }})
	core.keyName = "absent"
	if _, err := core.collectionKey(&Core{self: &rejectingModel{}, row: &rowState{}}, nil, nil); err == nil {
		t.Fatal("missing collection key column was accepted")
	}
}

func TestRelationKeyCollectionPropagatesInvalidValue(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	ref := &plan.ParentRef{Keys: []plan.KeyRef{{Index: 0}}}
	if _, err := parentValues(ref, [][]any{{struct{ ID int }{1}}}, nil); err == nil {
		t.Fatal("relation parent accepted unsupported key")
	}
	values, err := parentValues(ref, [][]any{{int64(1)}, {"1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 {
		t.Fatalf("distinct typed parent keys collapsed: %v", values)
	}
	key, present, err := keyFromRow([]any{struct{ ID int }{1}}, ref.Keys)
	if err == nil || present || key != (Key{}) {
		t.Fatalf("invalid relation row key: %v %v %v", key, present, err)
	}
}

func TestSplitQueryPropagatesInvalidKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const count = 1000
	params := make([]any, count)
	indexes := make([]int, count)
	for i := range params {
		params[i] = int64(i)
		indexes[i] = i
	}
	params[1] = struct{ ID int }{1}
	r := &request{params: params}
	r.ir.Query.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Op: "in", Ps: indexes}}}}
	step := &plan.Step{BindSlots: make([]plan.BindSlot, count)}
	if _, err := rootINParts(r, step, "sqlite"); err == nil {
		t.Fatal("split query accepted unsupported key")
	}
}

func TestSplitQueryRetainsDistinctTypedValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const count = 1000
	params := make([]any, count)
	indexes := make([]int, count)
	for i := range params {
		params[i] = int64(i)
		indexes[i] = i
	}
	params[0], params[1], params[2], params[3] = true, int64(1), []byte("x"), "x"
	r := &request{params: params}
	r.ir.Query.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Op: "in", Ps: indexes}}}}
	parts, err := rootINParts(r, &plan.Step{BindSlots: make([]plan.BindSlot, count)}, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	retained := map[int]bool{}
	for _, part := range parts {
		for _, index := range part.ir.Query.Where.Items[0].Pred.Ps {
			retained[index] = true
		}
	}
	for _, index := range []int{0, 1, 2, 3} {
		if !retained[index] {
			t.Errorf("typed split parameter %d disappeared", index)
		}
	}
}
