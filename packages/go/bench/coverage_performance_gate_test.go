//go:build featurecoverage

package bench

import (
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

// TestCoveragePerformanceGate runs the hot path gate against the seeded bench database at ORM_BENCH_MYSQL_DSN.
// It fails if the DSN is missing.
func TestCoveragePerformanceGate(t *testing.T) {
	testcase.Start(t, gateDeadline)
	hotPathGate(t)
}
