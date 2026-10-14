package analyzers_test

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
	"github.com/polyspec/orm/tests/analyzers"
	"golang.org/x/tools/go/analysis"
	"golang.org/x/tools/go/analysis/analysistest"
)

// Each analyzer runs over its package of testdata/src, whose `// want` comments are the reports it must give: a line
// without one is a case it must accept.
func TestAnalyzers(t *testing.T) {
	testcase.Group(t)
	for _, check := range []struct {
		analyzer *analysis.Analyzer
		packages []string
	}{
		{analyzers.DeferredExit, []string{"deferredexit"}},
		{analyzers.CallerPath, []string{"callerpath"}},
		{analyzers.TestCaseStart, []string{"testcasestart", analyzers.TestCasePackage}},
		{analyzers.CargoLease, []string{"cargolease"}},
		{analyzers.TimeFailure, []string{"timefailure"}},
	} {
		t.Run(check.analyzer.Name, func(t *testing.T) {
			testcase.Start(t, testcase.Compute)
			analysistest.Run(t, analysistest.TestData(), check.analyzer, check.packages...)
		})
	}
}
