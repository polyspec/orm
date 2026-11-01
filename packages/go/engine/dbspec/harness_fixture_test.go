//go:build dbspecfixture

package dbspec

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestFailingCaseFixture runs each case check with a vector that is wrong in only one expected value.
// Every case must fail, so it builds only with the tag dbspecfixture, which TestCaseHarnessReportsOnlyFailure gives
// to the child go test that runs it.
func TestFailingCaseFixture(t *testing.T) {
	testcase.Start(t, testcase.Process)
	p := loadPlanVectors(t)
	planCase := p.Cases[0]
	planCase.Changes = nil
	planInvalid := p.Invalid[0]
	planInvalid.Errors = nil
	chain := p.Chains[0]
	chain.Order = []string{"wrong"}
	parse := p.Parse[0]
	parse.Errors = nil
	// The first comparison has no differences, so the second case, which has differences, is emptied.
	comparison := p.Comparisons[1]
	comparison.Differences = nil
	t.Run("plan", func(t *testing.T) { checkPlanCase(t, planCase) })
	t.Run("plan_invalid", func(t *testing.T) { checkPlanInvalid(t, planInvalid) })
	t.Run("chain", func(t *testing.T) { checkPlanChain(t, chain) })
	t.Run("parse", func(t *testing.T) { checkPlanParse(t, parse) })
	t.Run("comparison", func(t *testing.T) { checkComparison(t, comparison) })
}
