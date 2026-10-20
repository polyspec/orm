//go:build featurecoverage

package orm_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// fixtureCase is one case in a feature fixture under contracts/fixtures.
type fixtureCase struct {
	ID        string          `json:"id"`
	Operation string          `json:"operation"`
	Input     json.RawMessage `json:"input"`
	Expected  json.RawMessage `json:"expected"`
	// Schema is the repository path of the dbspec document a planner case compiles against.
	Schema string `json:"schema"`
}

// featureFixture reads the case with the id from a feature fixture and checks that the case's operation
// is an operation. A missing or repeated id fails.
func featureFixture(t *testing.T, feature, id, operation string) fixtureCase {
	t.Helper()
	fixture := readFeatureDoc(t, feature)
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

// decodeFixture strictly reads the fixture's JSON value into out.
func decodeFixture(t *testing.T, raw json.RawMessage, out any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		t.Fatalf("fixture value %s: %v", raw, err)
	}
}

// runFixtureCases runs every case of the feature fixture, in file order, as a subtest named by its
// id with the test of that id in tests. A case without a test, or a test whose id is no case of
// the fixture, fails the run, so the suite and the tests stay the same set.
func runFixtureCases(t *testing.T, feature string, tests map[string]func(*testing.T)) {
	t.Helper()
	fixture := readFeatureDoc(t, feature)
	seen := map[string]bool{}
	for _, c := range fixture.Cases {
		seen[c.ID] = true
		test, ok := tests[c.ID]
		if !ok {
			t.Errorf("%s case %s has no test", feature, c.ID)
			continue
		}
		t.Run(c.ID, test)
	}
	for id := range tests {
		if !seen[id] {
			t.Errorf("%s has no case %s for its test", feature, id)
		}
	}
}

// featureDoc is the document of a feature fixture under contracts/fixtures.
type featureDoc struct {
	Feature string        `json:"feature"`
	Cases   []fixtureCase `json:"cases"`
}

// readFeatureDoc reads and decodes the feature fixture of feature; a failure fails the test.
func readFeatureDoc(t *testing.T, feature string) featureDoc {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "fixtures", feature+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture featureDoc
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("%s fixture: %v", feature, err)
	}
	return fixture
}
