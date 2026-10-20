//go:build dbspecfixture

package dbspec

import (
	"slices"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestFailingCaseFixture runs each case check with a vector that is wrong in only one expected value.
// Every case must fail, so it builds only with the tag dbspecfixture, which TestCaseHarnessReportsOnlyFailure gives
// to the child go test that runs it.
func TestFailingCaseFixture(t *testing.T) {
	testcase.Start(t, testcase.Process)
	m := loadMermaidVectors(t)
	p := loadPlanVectors(t)
	export := m.Export[0]
	export.Mermaid = append(slices.Clone(export.Mermaid), "%% wrong")
	imported := m.Import[0]
	imported.Document = append(slices.Clone(imported.Document), "wrong")
	invalid := m.Invalid[0]
	invalid.Errors = nil
	roundTrip := m.RoundTrip[0]
	roundTrip.Dropped = nil
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
	t.Run("export", func(t *testing.T) { checkMermaidExport(t, export) })
	t.Run("import", func(t *testing.T) { checkMermaidImport(t, imported) })
	t.Run("invalid", func(t *testing.T) { checkMermaidInvalid(t, invalid) })
	t.Run("round_trip", func(t *testing.T) { checkMermaidRoundTrip(t, roundTrip) })
	t.Run("plan", func(t *testing.T) { checkPlanCase(t, planCase) })
	t.Run("plan_invalid", func(t *testing.T) { checkPlanInvalid(t, planInvalid) })
	t.Run("chain", func(t *testing.T) { checkPlanChain(t, chain) })
	t.Run("parse", func(t *testing.T) { checkPlanParse(t, parse) })
	t.Run("comparison", func(t *testing.T) { checkComparison(t, comparison) })
}
