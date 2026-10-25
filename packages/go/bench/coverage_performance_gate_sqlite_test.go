//go:build featurecoverage

package bench

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// Requirements: PERF-1.
func TestCoveragePerformanceGateSQLite(t *testing.T) {
	testcase.Start(t, gateDeadline)
	coverageHotPathGate(t, "sqlite")
}
