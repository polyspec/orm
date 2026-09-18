// The hot-path regression gate compares the generated client with this
// package's native statements (same SQL, same typed scan), in one
// process, so the ratio is comparable on any machine. docs/perf.md §6d records
// the absolute numbers; this test fails when a client drifts past the bound.
//
//	make perf-check
package bench

import (
	"context"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/polyspec/orm/clients/go/model"
	"github.com/polyspec/orm/clients/go/orm"
)

// The ratio is comparable across machines. A Unix socket emphasizes fixed
// client cost; a TCP connection emphasizes database round-trip cost. The limits
// detect a client cost greater than one third of the equivalent native query.
const (
	pkBound   = 1.35
	listBound = 1.25
	gateIters = 300
)

func pairedP50(tb testing.TB, native, client func()) (time.Duration, time.Duration) {
	tb.Helper()
	for i := 0; i < 50; i++ {
		native()
		client()
	}
	n := make([]time.Duration, gateIters)
	c := make([]time.Duration, gateIters)
	for i := range n {
		start := time.Now()
		native()
		n[i] = time.Since(start)
		start = time.Now()
		client()
		c[i] = time.Since(start)
	}
	sort.Slice(n, func(i, j int) bool { return n[i] < n[j] })
	sort.Slice(c, func(i, j int) bool { return c[i] < c[j] })
	return n[len(n)/2], c[len(c)/2]
}

func TestHotPathGate(t *testing.T) {
	if os.Getenv("ORM_RUN_PERF_GATE") != "1" {
		t.Skip("set ORM_RUN_PERF_GATE=1 to run the timing-sensitive regression check")
	}
	sqlDB := open(t) // skips without a local MySQL
	ctx := context.Background()
	db, err := model.Connect(dsn(), "../../schema/schema.json", orm.Config{AESKey: "bench-salt", BlindIndexKey: "bench-blind-index"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	for _, c := range []struct {
		name           string
		native, client func()
		bound          float64
	}{
		{
			name:   "pk",
			native: func() { mustNoErr(t, func() error { _, err := pkGet(ctx, sqlDB, 42); return err }) },
			client: func() {
				mustNoErr(t, func() error { _, err := model.Battle().Connect(db).GetBySeq(42); return err })
			},
			bound: pkBound,
		},
		{
			name:   "list100",
			native: func() { mustNoErr(t, func() error { _, err := list100(ctx, sqlDB, 7); return err }) },
			client: func() {
				mustNoErr(t, func() error {
					_, err := model.Battle().Connect(db).ServiceSeq(7).AndIsClose(false).OrderBySeqDesc().Limit(0, 100).Gets()
					return err
				})
			},
			bound: listBound,
		},
	} {
		na, cl := pairedP50(t, c.native, c.client)
		ratio := float64(cl) / float64(na)
		fmt.Printf("%-8s native %6.1fµs  client %6.1fµs  ratio %.2f (bound %.2f)\n",
			c.name, float64(na.Microseconds()), float64(cl.Microseconds()), ratio, c.bound)
		if ratio > c.bound {
			t.Errorf("%s: client/native ratio %.2f exceeds limit %.2f; record the cause or a measured limit change in docs/perf.md", c.name, ratio, c.bound)
		}
	}
}

func mustNoErr(tb testing.TB, f func() error) {
	tb.Helper()
	if err := f(); err != nil {
		tb.Fatal(err)
	}
}
