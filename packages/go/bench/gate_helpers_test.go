//go:build featurecoverage || perfgate

// The hot-path regression gate compares the generated client with this
// package's native statements (same SQL, same typed scan), in one
// process, so the ratio is comparable on any machine. docs/operations/perf.md §6d records
// the absolute numbers; this test warns when a client drifts past the bound, and never fails on it (AGENTS.md).
//
//	make perf-check
package bench

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/polyspec/orm/packages/go/model"
	"github.com/polyspec/orm/packages/go/orm"
	"github.com/polyspec/orm/packages/go/testcase"
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

// hotPathGate measures every workload and warns when a ratio exceeds its bound; a measurement never fails t.
func hotPathGate(t *testing.T) {
	t.Helper()
	sqlDB := open(t)
	ctx := context.Background()
	db, err := model.Connect(dsn(t), orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	defer testcase.Close(t, db)

	for _, c := range []struct {
		name           string
		native, client func()
		bound          float64
	}{
		{
			name:   "pk",
			native: func() { mustNoErr(t, func() error { _, err := pkGet(ctx, sqlDB, 42); return err }) },
			client: func() {
				mustNoErr(t, func() error { _, err := model.Author().Connect(db).GetBySeq(42); return err })
			},
			bound: pkBound,
		},
		{
			name:   "list100",
			native: func() { mustNoErr(t, func() error { _, err := list100(ctx, sqlDB, 7); return err }) },
			client: func() {
				mustNoErr(t, func() error {
					_, err := model.Author().Connect(db).ServiceSeq(7).AndIsClose(false).OrderBySeqDesc().Limit(0, 100).Gets()
					return err
				})
			},
			bound: listBound,
		},
	} {
		na, cl, ratio := pairedRatio(t, c.native, c.client)
		fmt.Printf("%-8s native %6.1fµs  client %6.1fµs  ratio %.2f (bound %.2f)\n",
			c.name, float64(na.Microseconds()), float64(cl.Microseconds()), ratio, c.bound)
		if ratio > c.bound {
			testcase.Warn("%s: client/native ratio %.2f is above its reference %.2f (docs/operations/perf.md)", c.name, ratio, c.bound)
		}
	}
}

func mustNoErr(tb testing.TB, f func() error) {
	tb.Helper()
	if err := f(); err != nil {
		tb.Fatal(err)
	}
}
