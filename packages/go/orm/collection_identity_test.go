package orm

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/engine/ir"
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
}

func loadCollectionKeys(t *testing.T) collectionKeysFixture {
	t.Helper()
	src, err := os.ReadFile("../../../tests/collection/keys.json")
	if err != nil {
		t.Fatalf("read tests/collection/keys.json: %v; run make check from the checkout root", err)
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
			return entry.Value.(string)
		case "bool":
			return entry.Value.(bool)
		case "int":
			return int64(entry.Value.(float64))
		case "bytes":
			raw, err := hex.DecodeString(entry.Hex)
			if err != nil {
				t.Fatalf("fixture %s: %v", name, err)
			}
			return raw
		case "datetime":
			instant, err := time.Parse(time.RFC3339Nano, entry.Value.(string))
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

func TestCollectionKeyIdentityFromFixture(t *testing.T) {
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
}

func TestCollectionKeyNullIsCodecDecodeFromFixture(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	fixture := loadCollectionKeys(t)
	_, err := KeyOf(nil)
	ire, ok := err.(*ir.Error)
	if !ok || ire.Code != fixture.Null.Code {
		t.Fatalf("NULL key: got %v, want %s", err, fixture.Null.Code)
	}
	if ire.Msg != fixture.Null.Message {
		t.Errorf("NULL key message: got %q, want %q", ire.Msg, fixture.Null.Message)
	}
}
