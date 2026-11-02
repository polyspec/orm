//go:build dbspecfixture

package dbspec

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/internal/dbspec/plancases"
	"github.com/polyspec/orm/packages/go/testcase"
)

// TestFailingCaseFixture runs each case check with a vector that is wrong in only one expected value.
// Every case must fail, so it builds only with the tag dbspecfixture, which TestCaseHarnessReportsOnlyFailure gives
// to the child go test that runs it.
func TestFailingCaseFixture(t *testing.T) {
	testcase.Start(t, testcase.Process)
	planCase := loadPlanCases(t)[0]
	planCase.Changes = nil
	t.Run("plan", func(t *testing.T) { checkPlanChanges(t, planCase) })
}

// checkPlanChanges checks the changes of one plan case of plan-cases.json: the diff of its plan against its source
// must give the changes its dbspec.diff step expects. The harness fixture runs it with a wrong expectation.
func checkPlanChanges(t *testing.T, c plancases.Case) {
	runTimed(t, c.ID, 5*time.Second, func() error {
		return withPlanCase(c.Source, c.Plan, func(source *Document, p *Plan, diagnostics []Diagnostic) error {
			if len(diagnostics) > 0 {
				return fmt.Errorf("parse plan: %v", diagnostics)
			}
			changes, diagnostics := Diff(source, p)
			if len(diagnostics) > 0 {
				return fmt.Errorf("diff: %v", diagnostics)
			}
			var got [][3]string
			for _, ch := range changes {
				got = append(got, [3]string{ch.Kind, ch.Table, ch.Name})
			}
			if !slices.Equal(got, c.Changes) {
				return fmt.Errorf("changes\nwant %v\ngot  %v", c.Changes, got)
			}
			return nil
		})
	})
}
