//go:build featurecoverage

package bench

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

func TestCoveragePerformanceGatePostgres(t *testing.T) {
	testcase.Start(t, gateDeadline)
	coverageHotPathGate(t, "postgres")
}
