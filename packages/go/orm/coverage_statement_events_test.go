//go:build featurecoverage

package orm_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoverageStatementEvents runs on the database that the feature check selected (ORM_FEATURE_DATABASE)
// all cases of tests/events/vectors.json, each in a new case database, and compares them with the expected events
// The bench database is neither read nor written.
// Requirements: INT-91.
func TestCoverageStatementEvents(t *testing.T) {
	testcase.Start(t, testcase.Database)
	driver := os.Getenv("ORM_FEATURE_DATABASE")
	if !slices.Contains([]string{"mysql", "postgres", "sqlite"}, driver) {
		t.Fatal("ORM_FEATURE_DATABASE (mysql, postgres or sqlite) is required; run it through make feature-check, which sets it for each coverage case")
	}
	runEventCases(t, driver, false)
}

// runEventCases runs every case of the vector on the driver. If subtests are used, it runs each case
// as a subtest; otherwise (coverage receives the result of only one test) it runs them in order.
func runEventCases(t *testing.T, driver string, subtests bool) {
	cases := eventCases(t)
	recording := os.Getenv("ORM_EVENTS_RECORD") == "1"
	recorded := map[string][]eventRecord{}
	for _, c := range cases {
		runOne := func(t *testing.T) { runEventCase(t, driver, c, recording, recorded) }
		if subtests {
			t.Run(c.ID, runOne)
		} else {
			runOne(t)
		}
	}
	if recording {
		recordEvents(t, driver, recorded)
	}
}

// eventCases reads the cases of tests/events/vectors.json in file order.
func eventCases(t *testing.T) []eventCase {
	t.Helper()
	raw, err := os.ReadFile(eventsVector)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Cases []eventCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Cases
}

// runEventCase runs case c on driver in a new case database and compares its events with the
// vector, or keeps them in recorded when recording.
func runEventCase(t *testing.T, driver string, c eventCase, recording bool, recorded map[string][]eventRecord) {
	t.Helper()
	s := fixtureSchema(t, "statement_events/statement_events")
	dsn := newDatabase(t, driver)
	db := connectSchemaDB(t, dsn, s)
	defer testcase.Close(t, db)
	if c.Install == nil || *c.Install {
		if err := db.Utils().Schema().Install(s); err != nil {
			t.Fatal(err)
		}
	}
	r := &eventRun{t: t, db: db, schema: s, ent: rowEntity("event_probe", s, "seq", "label"), numbers: map[int64]int64{}}
	var err error
	if r.stopRec, err = db.Subscribe(r.record); err != nil {
		t.Fatal(err)
	}
	for _, s := range c.Steps {
		r.checked(s)
	}
	got := r.records
	if c.Compare == "tables" {
		got = nil
		for _, rec := range r.records {
			if len(rec.Tables) > 0 {
				got = append(got, rec)
			}
		}
	}
	if got == nil {
		got = []eventRecord{}
	}
	if recording {
		recorded[c.ID] = got
		return
	}
	if want := c.Events[driver]; !reflect.DeepEqual(normalized(t, got), normalized(t, want)) {
		gotJSON, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		wantJSON, err := json.MarshalIndent(want, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		t.Fatalf("%s events\n got %s\nwant %s", driver, gotJSON, wantJSON)
	}
}

// normalized is the record read back as JSON. Numbers and empty lists in bind take the same form.
func normalized(t testing.TB, records []eventRecord) any {
	t.Helper()
	raw, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// recordEvents writes the driver's expected events into each case of the vector.
func recordEvents(t *testing.T, driver string, recorded map[string][]eventRecord) {
	raw, err := os.ReadFile(eventsVector)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, c := range as[[]any](t, doc["cases"]) {
		cm := as[map[string]any](t, c)
		if events, ok := recorded[as[string](t, cm["id"])]; ok {
			as[map[string]any](t, cm["events"])[driver] = events
		}
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Clean(eventsVector), append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
