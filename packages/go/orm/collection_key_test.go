package orm

import (
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

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

// Requirements: INT-62, PLN-6, INT-81, INT-82, INT-83, INT-84, INT-85.
func TestCollectionViewsPreserveOrderAndConnectEveryModel(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	entity := &Entity{Value: func(model Model, name string) (any, bool) {
		for _, set := range model.Orm_().sets {
			if set.column == name {
				return set.value, true
			}
		}
		return nil, false
	}}
	makeModel := func(name string) *rejectingModel {
		core := NewCore(entity)
		model := &rejectingModel{core: core}
		core.Bind(model)
		core.Set("label", name)
		return model
	}
	first, second := makeModel("first"), makeModel("second")
	one, err := KeyOf(int64(7))
	if err != nil {
		t.Fatalf("KeyOf(int64(7)): %v", err)
	}
	two, err := KeyOf("7")
	if err != nil {
		t.Fatalf("KeyOf(\"7\"): %v", err)
	}
	collection := NewCollection[*rejectingModel]()
	collection.keys = []Key{one, two}
	collection.items[one], collection.items[two] = first, second
	if got := collection.Len(); got != 2 {
		t.Fatalf("length = %d, want 2", got)
	}
	if got := collection.First(); got != first {
		t.Fatalf("first = %v, want first model", got)
	}
	if got, err := collection.Get(int64(7)); err != nil || got != first {
		t.Fatalf("lookup integer key = %v, %v; want first model", got, err)
	}
	if got, err := collection.Get("7"); err != nil || got != second {
		t.Fatalf("lookup text key = %v, %v; want second model", got, err)
	}

	if got := collection.Keys(); !reflect.DeepEqual(got, []Key{one, two}) {
		t.Fatalf("keys = %#v, want ordered keys %#v", got, []Key{one, two})
	}
	if got := collection.Slice(); !reflect.DeepEqual(got, []*rejectingModel{first, second}) {
		t.Fatalf("slice = %#v, want models in key order", got)
	}
	var entries []string
	for key, model := range collection.All() {
		label, ok := model.core.ToArray()["label"].(string)
		if !ok {
			t.Fatalf("label of %s = %#v, want a string", key.String(), model.core.ToArray()["label"])
		}
		entries = append(entries, key.String()+":"+label)
	}
	if !reflect.DeepEqual(entries, []string{"7:first", "7:second"}) {
		t.Fatalf("entries = %#v, want key/model pairs in order", entries)
	}
	if got := collection.ToArray(); !reflect.DeepEqual(got, []map[string]any{{"label": "first"}, {"label": "second"}}) {
		t.Fatalf("toArray = %#v, want model maps in order", got)
	}
	db := &DB{}
	if got := collection.Connect(db); got != collection || first.core.conn != db || second.core.conn != db {
		t.Fatal("connect did not return the collection and set both model connections")
	}
}

// Requirements: INT-88, INT-89.
func TestTerminalReturnsTheFirstRecordedBuilderError(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	core := NewCore(&Entity{})
	core.Limit(-1, 1)
	core.Limit(0, 0)
	_, err := core.GetCount()
	if ErrorCode(err) != CodeConfig || err.Error() != "CONFIG: limit requires a non-negative offset and a positive count" {
		t.Fatalf("terminal error = %v, want the first builder error", err)
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
	params, indexes := indexedParams(count)
	params[1] = struct{ ID int }{1}
	r := &request{params: params}
	r.ir.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Op: "in", Ps: indexes}}}}
	if _, err := rootINParts(r, count, "sqlite"); err == nil {
		t.Fatal("split query accepted unsupported key")
	}
}

// Requirements: PRT-35.
func TestSplitQueryRowKeyRejectsSQLNull(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	_, err := splitQueryRowKey([]any{nil}, []plan.KeyRef{{Column: "id", Index: 0}})
	if err == nil || !strings.Contains(err.Error(), "CODEC_DECODE: split query row identity contains SQL NULL") {
		t.Fatalf("split query row key error = %v", err)
	}
	compositeRefs := []plan.KeyRef{{Column: "tenant_id", Index: 0}, {Column: "enabled", Index: 1}, {Column: "label", Index: 2}}
	if _, err := splitQueryRowKey([]any{int64(0), nil, ""}, compositeRefs); err == nil || !strings.Contains(err.Error(), "CODEC_DECODE: split query row identity contains SQL NULL") {
		t.Fatalf("composite split query row key error = %v", err)
	}
	if _, err := splitQueryRowKey([]any{int64(0), false, ""}, compositeRefs); err != nil {
		t.Fatalf("valid composite falsey key: %v", err)
	}
	for _, value := range []any{int64(0), false, ""} {
		if _, err := splitQueryRowKey([]any{value}, []plan.KeyRef{{Column: "id", Index: 0}}); err != nil {
			t.Errorf("valid falsey key %T(%v): %v", value, value, err)
		}
	}
}

func TestSplitQueryRetainsDistinctTypedValues(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	const count = 1000
	params, indexes := indexedParams(count)
	params[0], params[1], params[2], params[3] = true, int64(1), []byte("x"), "x"
	r := &request{params: params}
	r.ir.Where = &ir.Group{Items: []ir.Item{{Pred: &ir.Pred{Op: "in", Ps: indexes}}}}
	parts, err := rootINParts(r, count, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	retained := map[int]bool{}
	for _, part := range parts {
		for _, index := range part.ir.Where.Items[0].Pred.Ps {
			retained[index] = true
		}
	}
	for _, index := range []int{0, 1, 2, 3} {
		if !retained[index] {
			t.Errorf("typed split parameter %d disappeared", index)
		}
	}
}

// TestExpandInKeepsBareDollar checks that expanding a parent slot renumbers only the $n placeholders: a '$' that does not
// start a number is text and is written as it is (docs/spec/dsl.md DSL-153), so the literal keeps its '$' and gains no number.
func TestExpandInKeepsBareDollar(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	st := &plan.Step{
		SQL:       "SELECT '$' AS sign, id FROM items WHERE key IN ($1)",
		BindSlots: []plan.BindSlot{{From: "parent"}},
		Parent:    &plan.ParentRef{Keys: []plan.KeyRef{{Column: "key", Index: 0}}},
	}
	sql, args, err := expandIn(st, []any{int64(1), int64(2), int64(3)})
	if err != nil {
		t.Fatal(err)
	}
	const want = "SELECT '$' AS sign, id FROM items WHERE key IN ($1, $2, $3, $4)"
	if sql != want {
		t.Fatalf("expanded statement = %q, want %q", sql, want)
	}
	if len(args) != 4 {
		t.Fatalf("expanded to %d arguments, want 4 (three keys padded to a power of two)", len(args))
	}
}

// Requirements: PRT-40.
func TestParentSlotExpansionPadsCompositeKeysAndRenumbersFollowingSlots(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	step := &plan.Step{
		SQL:       "SELECT $1 WHERE (a, b) IN (($2)) AND active = $3",
		BindSlots: []plan.BindSlot{{From: "param"}, {From: "parent"}, {From: "param"}},
		Parent:    &plan.ParentRef{Keys: []plan.KeyRef{{Column: "a", Index: 0}, {Column: "b", Index: 1}}},
	}
	sql, args, err := expandIn(step, []any{int64(10), int64(11), int64(20), int64(21), int64(30), int64(31)})
	if err != nil {
		t.Fatal(err)
	}
	const wantSQL = "SELECT $1 WHERE (a, b) IN (($2, $3), ($4, $5), ($6, $7), ($8, $9)) AND active = $10"
	if sql != wantSQL {
		t.Fatalf("expanded statement = %q, want %q", sql, wantSQL)
	}
	wantArgs := []any{int64(10), int64(11), int64(20), int64(21), int64(30), int64(31), int64(30), int64(31)}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("expanded parent values = %#v, want %#v", args, wantArgs)
	}
}

// indexedParams returns count parameters whose values are the int64 of their
// position, and the list of their positions.
func indexedParams(count int) ([]any, []int) {
	params := make([]any, count)
	indexes := make([]int, count)
	for i := range params {
		params[i] = int64(i)
		indexes[i] = i
	}
	return params, indexes
}
