package gen_test

// Hot-path gate (docs/perf.md §6): generated client vs the native baseline in
// bench/go (same statements, prepared, single connection).
//   go test ./clients/go/gen -run xxx -bench . -benchmem

import (
	"context"
	"testing"

	"github.com/polyspec/orm/clients/go/gen"
)

func BenchmarkClientPKGet(b *testing.B) {
	db := open(&testing.T{})
	db.SQL.SetMaxOpenConns(1)
	ctx := context.Background()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		r, err := gen.NewBattle().SeqEq(int64(i%100000+1)).One(ctx, db)
		if err != nil || r == nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkClientList100(b *testing.B) {
	db := open(&testing.T{})
	db.SQL.SetMaxOpenConns(1)
	ctx := context.Background()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		rows, err := gen.NewBattle().ServiceSeqEq(int64(i%100+1)).IsCloseEq(false).OrderBySeqDesc().Limit(0, 100).All(ctx, db)
		if err != nil || rows.Len() == 0 {
			b.Fatalf("%v %d", err, rows.Len())
		}
	}
}

func BenchmarkClientPlanCacheHit(b *testing.B) {
	db := open(&testing.T{})
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		q := gen.NewBattle().ServiceSeqEq(int64(i)).IsCloseEq(false).OrderBySeqDesc().Limit(0, 100)
		if _, err := db.Plan(q.Req()); err != nil {
			b.Fatal(err)
		}
	}
}
