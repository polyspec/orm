package gen_test

import (
	"context"
	"testing"

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
)

// A root IN list of varying length must not mint a statement per length: the
// server's prepared-statement cache and our plan cache both grow with the
// number of distinct statements, so the list is padded to a power of two.
func TestINListIsBucketed(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	seen := map[string]int{}
	db.Cfg().OnQuery = func(e orm.Event) { seen[e.SQL] = len(e.Args) }
	for n := 1; n <= 12; n++ {
		ids := make([]int64, n)
		for i := range ids {
			ids[i] = int64(i + 1)
		}
		got, err := gen.Battle().SeqIn(ids).Using(ctx, db).GetCount()
		if err != nil {
			t.Fatal(err)
		}
		if want := int64(n); got != want {
			t.Errorf("IN of %d ids matched %d rows, want %d (padding must repeat a value, never add one)", n, got, want)
		}
	}
	db.Cfg().OnQuery = nil
	// lengths 1..12 fall into the buckets 1, 2, 4, 8, 16
	if len(seen) > 5 {
		t.Errorf("IN lengths 1..12 produced %d distinct statements, want at most 5 (power-of-two buckets):", len(seen))
		for s, n := range seen {
			t.Errorf("  %d binds: …%s", n, s[max(0, len(s)-70):])
		}
	}
}

func TestLargeRootINIsChunkedForSQLite(t *testing.T) {
	if testDriver() != "sqlite" {
		t.Skip("requires the SQLite physical fixture")
	}
	db := open(t)
	ctx := context.Background()
	ids := make([]int64, 1000)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	if _, err := gen.Battle().SeqIn(ids).Using(ctx, db).GetCount(); err != nil {
		t.Fatalf("large root IN failed on SQLite: %v", err)
	}
}

func TestLargeRootINRowsAndCount(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	ids := make([]int64, 1000)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	count, err := gen.Battle().SeqIn(ids).Using(ctx, db).GetCount()
	if err != nil || count != 1000 {
		t.Fatalf("large root IN count=%d err=%v, want 1000", count, err)
	}
	rows, err := gen.Battle().SeqIn(ids).Using(ctx, db).Gets()
	if err != nil {
		t.Fatalf("large root IN rows failed: %v", err)
	}
	if rows == nil || rows.Len() != 1000 {
		got := 0
		if rows != nil {
			got = rows.Len()
		}
		t.Fatalf("large root IN rows=%d, want 1000", got)
	}
}
