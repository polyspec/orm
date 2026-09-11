// The hot-path regression gate: the generated client measured against this
// package's hand-written native statements (same SQL, same typed scan), in one
// process, so the ratio is comparable on any machine. docs/perf.md §6d records
// the absolute numbers; this test fails when a client drifts past the bound.
//
//	go test ./bench/go -run TestHotPathGate -v
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

// Bounds are the ratios measured here plus headroom for a loaded CI box. One row
// is dominated by the per-statement fixed cost (§6b), 100 rows by row mapping.
// The PK bound is below 1 because the generated client currently beats this
// package's hand-written helper (which rebuilds its scan targets per call): the
// gate's job is to notice when that stops being true.
const (
	pkBound   = 0.90
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
			client: func() { mustNoErr(t, func() error { _, err := gen.NewBattle().OneBySeq(ctx, db, 42); return err }) },
			bound:  pkBound,
		},
		{
			name:   "list100",
			native: func() { mustNoErr(t, func() error { _, err := list100(ctx, sqlDB, 7); return err }) },
			client: func() {
				mustNoErr(t, func() error {
					_, err := gen.NewBattle().ServiceSeqEq(7).IsCloseEq(false).OrderBySeqDesc().Limit(0, 100).All(ctx, db)
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
			t.Errorf("%s: the client is %.2fx the native statement, bound %.2fx — explain the regression or move the bound in docs/perf.md", c.name, ratio, c.bound)
		}
	}
}

func mustNoErr(tb testing.TB, f func() error) {
	tb.Helper()
	if err := f(); err != nil {
		tb.Fatal(err)
	}
}
