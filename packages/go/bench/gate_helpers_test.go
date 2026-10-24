//go:build featurecoverage || perfgate

// The hot-path regression gate compares the generated client with this
// package's native statements (same SQL, same typed scan), in one
// process, so the ratio is comparable on any machine. docs/operations/perf.md §6d records
// the absolute numbers; this test warns when a client drifts past the bound, and never fails on it (AGENTS.md).
//
//	make perf-check
package bench

import (
	"sort"
	"testing"
	"time"
)

// The ratio is comparable across machines. A Unix socket emphasizes fixed
// client cost; a TCP connection emphasizes database round-trip cost. The limits
// detect a client cost greater than one third of the equivalent native query.
const (
	pkBound   = 1.35
	listBound = 1.25
	gateWarm  = 100
	gatePairs = 1000
)

// gateDeadline is the deadline of a hot-path gate case. Each workload sends the gateWarm+gatePairs pairs of
// native and client calls to the bench database, and even while a load process uses all CPUs,
// they finish within a few tens of seconds, so five minutes only ends a case that is stuck.
const gateDeadline = 5 * time.Minute

// pairedRatio measures native and client in adjacent pairs, alternating which
// side runs first, and returns the median native and client times and the
// median of the per-pair client/native ratios. Load that slows one pair slows
// both of its sides, so the median ratio does not follow the machine load.
func pairedRatio(tb testing.TB, native, client func()) (time.Duration, time.Duration, float64) {
	tb.Helper()
	for i := 0; i < gateWarm; i++ {
		native()
		client()
	}
	n := make([]time.Duration, gatePairs)
	c := make([]time.Duration, gatePairs)
	ratios := make([]float64, gatePairs)
	timed := func(f func()) time.Duration {
		start := time.Now()
		f()
		return time.Since(start)
	}
	for i := range n {
		if i%2 == 0 {
			n[i] = timed(native)
			c[i] = timed(client)
		} else {
			c[i] = timed(client)
			n[i] = timed(native)
		}
		ratios[i] = float64(c[i]) / float64(n[i])
	}
	sort.Slice(n, func(i, j int) bool { return n[i] < n[j] })
	sort.Slice(c, func(i, j int) bool { return c[i] < c[j] })
	sort.Float64s(ratios)
	return n[len(n)/2], c[len(c)/2], ratios[len(ratios)/2]
}
