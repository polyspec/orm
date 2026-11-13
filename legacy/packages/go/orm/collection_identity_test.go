package orm

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/polyspec/orm/legacy/packages/go/engine/plan"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// collectionKeysFixture is tests/collection/keys.json: the collection key identity that every implementation shares.
type collectionKeysFixture struct {
	Composites []struct {
		Name    string           `json:"name"`
		Values  []map[string]any `json:"values"`
		Encoded string           `json:"encoded"`
		SameAs  string           `json:"same_as"`
	} `json:"composites"`
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
