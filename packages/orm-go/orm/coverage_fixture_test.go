//go:build featurecoverage

package orm_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fixtureCase는 contracts/fixtures의 feature fixture에 있는 case 하나다.
type fixtureCase struct {
	ID        string          `json:"id"`
	Operation string          `json:"operation"`
	Input     json.RawMessage `json:"input"`
	Expected  json.RawMessage `json:"expected"`
}

// featureFixture는 feature fixture에서 id의 case를 읽고, case의 operation이
// operation인지 확인한다. 없거나 반복된 id는 실패다.
func featureFixture(t *testing.T, feature, id, operation string) fixtureCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", feature+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Feature string        `json:"feature"`
		Cases   []fixtureCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("%s fixture: %v", feature, err)
	}
	if fixture.Feature != feature {
		t.Fatalf("%s fixture names feature %q", feature, fixture.Feature)
	}
	var found []fixtureCase
	for _, c := range fixture.Cases {
		if c.ID == id {
			found = append(found, c)
		}
	}
	if len(found) != 1 {
		t.Fatalf("%s fixture has %d cases %s, want 1", feature, len(found), id)
	}
	if found[0].Operation != operation {
		t.Fatalf("%s case %s has operation %q, want %q", feature, id, found[0].Operation, operation)
	}
	return found[0]
}

// decodeFixture는 fixture의 JSON 값을 out에 엄격히 읽는다.
func decodeFixture(t *testing.T, raw json.RawMessage, out any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		t.Fatalf("fixture value %s: %v", raw, err)
	}
}
