//go:build featurecoverage

package bench

import "testing"

// TestCoveragePerformanceGate는 ORM_BENCH_MYSQL_DSN의 seed bench database에서
// hot path gate를 실행한다. DSN이 없으면 실패한다.
func TestCoveragePerformanceGate(t *testing.T) { hotPathGate(t) }
