package orm

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
	"github.com/polyspec/orm/packages/go/engine/plan"
	"github.com/polyspec/orm/packages/go/testcase"
)

// collectionKeysFixture is tests/collection/keys.json: the collection key identity that every implementation shares.
type collectionKeysFixture struct {
	Null struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"null"`
	Keys []struct {
		Name   string `json:"name"`
		Type   string `json:"type"`
		Value  any    `json:"value"`
		Hex    string `json:"hex"`
		SameAs string `json:"same_as"`
	} `json:"keys"`
	Composites []struct {
		Name    string           `json:"name"`
		Values  []map[string]any `json:"values"`
		Encoded string           `json:"encoded"`
		SameAs  string           `json:"same_as"`
	} `json:"composites"`
	DateTimeMicroseconds []struct {
		Name    string `json:"name"`
		Value   string `json:"value"`
		Encoded string `json:"encoded"`
	} `json:"datetime_microseconds"`
	NullableComposite []map[string]any `json:"nullable_composite"`
}

func loadCollectionKeys(t *testing.T) collectionKeysFixture {
	t.Helper()
	src, err := os.ReadFile("../../../tests/collection/keys.json")
	if err != nil {
		t.Fatalf("read tests/collection/keys.json: %v; run make orm-check from the checkout root", err)
	}
	var fixture collectionKeysFixture
	if err := json.Unmarshal(src, &fixture); err != nil {
		t.Fatalf("decode tests/collection/keys.json: %v", err)
	}
	return fixture
}

// value builds the Go value of one fixture entry, with the type that its client reads from a column.
func (k collectionKeysFixture) keyValue(t *testing.T, name string) any {
	t.Helper()
	for _, entry := range k.Keys {
		if entry.Name != name {
			continue
		}
		switch entry.Type {
		case "text":
			return as[string](t, entry.Value)
		case "bool":
			return as[bool](t, entry.Value)
		case "int":
			return int64(as[float64](t, entry.Value))
		case "bytes":
			raw, err := hex.DecodeString(entry.Hex)
			if err != nil {
				t.Fatalf("fixture %s: %v", name, err)
			}
			return raw
		case "datetime":
			instant, err := time.Parse(time.RFC3339Nano, as[string](t, entry.Value))
			if err != nil {
				t.Fatalf("fixture %s: %v", name, err)
			}
			return instant
		}
		t.Fatalf("fixture %s has unknown type %q", name, entry.Type)
	}
	t.Fatalf("fixture entry %s is absent", name)
	return nil
}

func fixtureValue(t *testing.T, entry map[string]any) any {
	t.Helper()
	switch entry["type"] {
	case "text":
		return as[string](t, entry["value"])
	case "bool":
		return as[bool](t, entry["value"])
	case "int":
		return int64(as[float64](t, entry["value"]))
	case "bytes":
		value, err := hex.DecodeString(as[string](t, entry["hex"]))
		if err != nil {
			t.Fatalf("decode composite bytes: %v", err)
		}
		return value
	case "datetime":
		value, err := time.Parse(time.RFC3339Nano, as[string](t, entry["value"]))
		if err != nil {
			t.Fatalf("parse composite datetime: %v", err)
		}
		return value
	case "null":
		return nil
	default:
		t.Fatalf("unknown composite component type %q", entry["type"])
		return nil
	}
}

func compositeKeyFromFixture(t *testing.T, name, encoded string, values []any) Key {
	t.Helper()
	key, err := keyFromValues(values)
	if err != nil {
		t.Fatalf("key %s: %v", name, err)
	}
	if got := key.String(); got != encoded {
		t.Errorf("key %s: got %q, want %q", name, got, encoded)
	}
	again, err := keyFromValues(values)
	if err != nil || again != key {
		t.Errorf("key %s changed on repeated creation: %v", name, err)
	}
	return key
}

func TestCollectionKeyIdentityFromFixture(t *testing.T) {
	// Requirements: INT-11, INT-63, PRT-35.
	testcase.Start(t, testcase.Compute)
	fixture := loadCollectionKeys(t)
	keys := map[string]Key{}
	for _, entry := range fixture.Keys {
		key, err := KeyOf(fixture.keyValue(t, entry.Name))
		if err != nil {
			t.Fatalf("key %s: %v", entry.Name, err)
		}
		again, err := KeyOf(fixture.keyValue(t, entry.Name))
		if err != nil || again != key {
			t.Errorf("key %s has no stable identity: %v", entry.Name, err)
		}
		got, err := key.Value()
		if err != nil {
			t.Errorf("key %s value: %v", entry.Name, err)
		} else if want := fixture.keyValue(t, entry.Name); !sameKeyValue(got, want) {
			t.Errorf("key %s lost its native value type: got %T(%v), want %T(%v)", entry.Name, got, got, want, want)
		}
		if entry.SameAs != "" {
			if want := keys[entry.SameAs]; key != want {
				t.Errorf("key %s differs from %s", entry.Name, entry.SameAs)
			}
			continue
		}
		for other, otherKey := range keys {
			if otherKey == key {
				t.Errorf("keys %s and %s have the same identity", entry.Name, other)
			}
		}
		keys[entry.Name] = key
	}
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

// Requirements: INT-80, INT-86.
func TestCollectionGetAndFetchedValueUseTypedKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	integerKey, err := KeyOf(int64(7))
	if err != nil {
		t.Fatal(err)
	}
	textKey, err := KeyOf("7")
	if err != nil {
		t.Fatal(err)
	}
	integerModel := &rejectingModel{}
	textModel := &rejectingModel{}
	collection := &Collection[*rejectingModel]{
		keys:    []Key{integerKey, textKey},
		items:   map[Key]*rejectingModel{integerKey: integerModel, textKey: textModel},
		fetched: map[Key]any{integerKey: "integer", textKey: "text"},
	}
	if got, err := collection.Get(int64(7)); err != nil || got != integerModel {
		t.Fatalf("Get(integer key): got %p, err %v", got, err)
	}
	if got, err := collection.Get("7"); err != nil || got != textModel {
		t.Fatalf("Get(text key): got %p, err %v", got, err)
	}
	if got, err := collection.Get(int64(8)); err != nil || got != nil {
		t.Fatalf("Get(missing key): got %p, err %v", got, err)
	}
	for _, test := range []struct {
		key  any
		want any
	}{{int64(7), "integer"}, {"7", "text"}, {int64(8), nil}} {
		got, err := collection.FetchedValue(test.key)
		if err != nil || got != test.want {
			t.Errorf("FetchedValue(%T(%v)): got %#v, err %v; want %#v", test.key, test.key, got, err, test.want)
		}
	}
}

func sameKeyValue(got, want any) bool {
	if a, ok := got.(time.Time); ok {
		b, isTime := want.(time.Time)
		return isTime && a.Equal(b)
	}
	return reflect.DeepEqual(got, want)
}

func TestCollectionKeyNullIsCodecDecodeFromFixture(t *testing.T) {
	// Requirements: PRT-35.
	testcase.Start(t, testcase.Compute)
	fixture := loadCollectionKeys(t)
	_, err := KeyOf(nil)
	var ire *ir.Error
	ok := errors.As(err, &ire)
	if !ok || ire.Code != fixture.Null.Code {
		t.Fatalf("NULL key: got %v, want %s", err, fixture.Null.Code)
	}
	if ire.Msg != fixture.Null.Message {
		t.Errorf("NULL key message: got %q, want %q", ire.Msg, fixture.Null.Message)
	}
}

func TestCompositeCollectionKeyTypedComponentsFromFixture(t *testing.T) {
	// Requirements: PRT-35.
	testcase.Start(t, testcase.Compute)
	fixture := loadCollectionKeys(t)
	seen := map[string]Key{}
	for _, entry := range fixture.Composites {
		values := make([]any, len(entry.Values))
		for i, value := range entry.Values {
			values[i] = fixtureValue(t, value)
		}
		key := compositeKeyFromFixture(t, entry.Name, entry.Encoded, values)
		if entry.SameAs != "" {
			if want, ok := seen[entry.SameAs]; !ok || key != want {
				t.Errorf("key %s differs from %s", entry.Name, entry.SameAs)
			}
			continue
		}
		for other, otherKey := range seen {
			if key == otherKey {
				t.Errorf("keys %s and %s have the same identity", other, entry.Name)
			}
		}
		seen[entry.Name] = key
	}
}

func TestCompositeCollectionKeyMicrosecondPrecisionFromFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	fixture := loadCollectionKeys(t)
	for _, entry := range fixture.DateTimeMicroseconds {
		instant, err := time.Parse(time.RFC3339Nano, entry.Value)
		if err != nil {
			t.Fatalf("parse fixture %s: %v", entry.Name, err)
		}
		values := []any{instant, ""}
		compositeKeyFromFixture(t, entry.Name, entry.Encoded, values)
	}
}

func TestNullableCompositeRowHasNoCollectionKey(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	fixture := loadCollectionKeys(t)
	row := make([]any, len(fixture.NullableComposite))
	for i, value := range fixture.NullableComposite {
		row[i] = fixtureValue(t, value)
	}
	key, present, err := keyFromRow(row, []plan.KeyRef{{Column: "first", Index: 0}, {Column: "second", Index: 1}})
	if err != nil || present || key.tag != 0 {
		t.Fatalf("nullable composite row: key=%#v present=%v err=%v, want absent key", key, present, err)
	}
}
