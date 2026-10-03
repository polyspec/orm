package dialects

import (
	"testing"
	"time"

	"github.com/polyspec/orm/internal/testcase"
)

// TestProbeIDs verifies that probe IDs are unique, well formed and name the
// database each probe runs on.
func TestProbeIDs(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	begin := time.Now()
	probes := All()
	if err := Validate(probes); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]Probe{
		{{ID: "mysql.a.b", DB: "mysql", Fact: "f", Run: func(*Env) {}}, {ID: "mysql.a.b", DB: "mysql", Fact: "f", Run: func(*Env) {}}},
		{{ID: "mysql.a.b", DB: "sqlite", Fact: "f", Run: func(*Env) {}}},
		{{ID: "mysql.A.b", DB: "mysql", Fact: "f", Run: func(*Env) {}}},
		{{ID: "mysql.a.b", DB: "mysql", Run: func(*Env) {}}},
	} {
		if err := Validate(bad); err == nil {
			t.Errorf("Validate accepted %+v", bad[len(bad)-1].ID)
		}
	}
	t.Logf("%d probe IDs valid in %s", len(probes), time.Since(begin).Round(time.Microsecond))
}
