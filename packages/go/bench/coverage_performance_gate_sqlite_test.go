//go:build featurecoverage

package bench

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestCoveragePerformanceGateSQLite(t *testing.T) {
	testcase.Start(t, gateDeadline)
	coverageHotPathGate(t, "sqlite")
}
