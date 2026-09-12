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

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
	"github.com/polyspec/orm/engine"
	"github.com/polyspec/orm/engine/schema"
)

// The ratio is comparable across machines. A Unix socket emphasizes fixed
// client cost; a TCP connection emphasizes database round-trip cost. The limits
// detect a client cost greater than one third of the equivalent native query.
const (
	pkBound   = 1.35
	listBound = 1.25
	gateIters = 300
)

func p50(tb testing.TB, f func()) time.Duration {
	tb.Helper()
	for i := 0; i < 50; i++ {
		f()
	}
	s := make([]time.Duration, gateIters)
	for i := range s {
		start := time.Now()
		f()
		s[i] = time.Since(start)
	}
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

func TestHotPathGate(t *testing.T) {
	if os.Getenv("ORM_RUN_PERF_GATE") != "1" {
		t.Skip("set ORM_RUN_PERF_GATE=1 to run the timing-sensitive regression check")
	}
	sqlDB := open(t) // skips without a local MySQL
	ctx := context.Background()
	js, err := os.ReadFile("../../schema/schema.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := schema.Load(js)
	if err != nil {
		t.Fatal(err)
	}
	eng, err := engine.New(m, "mysql")
	if err != nil {
		t.Fatal(err)
	}
	db, err := orm.Open("mysql", dsn(), eng, orm.Config{AESKey: "bench-salt"})
	if err != nil {
		t.Fatal(err)
	}
	defer db.SQL.Close()
	if err := gen.Init(eng); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name           string
		native, client func()
		bound          float64
	}{
		{
			name:   "pk",
			native: func() { mustNoErr(t, func() error { _, err := pkGet(ctx, sqlDB, 42); return err }) },
			client: func() {
				mustNoErr(t, func() error { _, err := gen.Battle().Using(ctx, db).GetBySeq(42); return err })
			},
			bound: pkBound,
		},
		{
			name:   "list100",
			native: func() { mustNoErr(t, func() error { _, err := list100(ctx, sqlDB, 7); return err }) },
			client: func() {
				mustNoErr(t, func() error {
					_, err := gen.Battle().ServiceSeq(7).IsClose(false).OrderBySeqDesc().Limit(0, 100).Using(ctx, db).Gets()
					return err
				})
			},
			bound: listBound,
		},
	} {
		na, cl := p50(t, c.native), p50(t, c.client)
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
