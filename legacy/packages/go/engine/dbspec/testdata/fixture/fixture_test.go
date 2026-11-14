// The fixture test of TestCaseHarnessReportsOnlyFailure. It lives in testdata, which go test ./... never matches,
// and the harness test runs it with a child go test of this directory, since it fails by design.
package fixture

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/polyspec/orm/legacy/packages/go/engine/dbspec"
	"github.com/polyspec/orm/legacy/packages/go/internal/dbspec/plancases"
	"github.com/polyspec/orm/legacy/packages/go/testcase"
)

// TestFailingCaseFixture runs the first plan case of plan-cases.json with its expected changes removed, so the
// case must fail on only that value, and reports it in the form of the case runner: one FAIL line and no PASS line.
func TestFailingCaseFixture(t *testing.T) {
	testcase.Start(t)
	cases, err := plancases.Read(filepath.Join(testcase.LegacyRoot(), "tests", "dbspec", "plan-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	planCase := cases[0]
	planCase.Changes = nil
	if err := checkPlanChanges(planCase); err != nil {
		t.Errorf("FAIL %s elapsed=0s: %v", planCase.ID, err)
		return
	}
	t.Logf("PASS %s", planCase.ID)
}

// checkPlanChanges compares the diff of the plan of a case against its source with the changes that the case expects.
func checkPlanChanges(c plancases.Case) error {
	var source *dbspec.Document
	if c.Source != nil {
		document, _, diagnostics := dbspec.Parse(strings.Join(c.Source, "\n")+"\n", nil)
		if len(diagnostics) > 0 {
			return fmt.Errorf("parse source: %v", diagnostics)
		}
		source = document
	}
	plan, diagnostics := dbspec.ParsePlan(strings.Join(c.Plan, "\n") + "\n")
	if len(diagnostics) > 0 {
		return fmt.Errorf("parse plan: %v", diagnostics)
	}
	changes, diagnostics := dbspec.Diff(source, plan)
	if len(diagnostics) > 0 {
		return fmt.Errorf("diff: %v", diagnostics)
	}
	var got [][3]string
	for _, change := range changes {
		got = append(got, [3]string{change.Kind, change.Table, change.Name})
	}
	if !slices.Equal(got, c.Changes) {
		return fmt.Errorf("changes\nwant %v\ngot  %v", c.Changes, got)
	}
	return nil
}
