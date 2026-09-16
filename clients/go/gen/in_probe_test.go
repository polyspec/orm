package gen_test

import (
	"testing"

	"github.com/polyspec/orm/clients/go/gen"
	"github.com/polyspec/orm/clients/go/orm"
)

// A root IN list of varying length must not mint a statement per length: the
// server's prepared-statement cache and our plan cache both grow with the
// number of distinct statements, so the list is padded to a power of two.
func TestINListIsBucketed(t *testing.T) {
	db := open(t)
	seen := map[string]int{}
	db.Cfg().OnQuery = func(e orm.Event) { seen[e.SQL] = len(e.Args) }
	for n := 1; n <= 12; n++ {
		ids := make([]int64, n)
		for i := range ids {
			ids[i] = int64(i + 1)
		}
		got, err := gen.Battle().SeqIn(ids).Using(db).GetCount()
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
	ids := existingBattleIDs(t, db, 1000)
	if _, err := gen.Battle().SeqIn(ids).Using(db).GetCount(); err != nil {
		t.Fatalf("large root IN failed on SQLite: %v", err)
	}
}

func TestLargeRootINRowsAndCount(t *testing.T) {
	db := open(t)
	ids := existingBattleIDs(t, db, 1000)
	count, err := gen.Battle().SeqIn(ids).Using(db).GetCount()
	if err != nil || count != int64(len(ids)) {
		t.Fatalf("large root IN count=%d err=%v, want %d", count, err, len(ids))
	}
	rows, err := gen.Battle().SeqIn(ids).Using(db).Gets()
	if err != nil {
		t.Fatalf("large root IN rows failed: %v", err)
	}
	if rows == nil || rows.Len() != len(ids) {
		got := 0
		if rows != nil {
			got = rows.Len()
		}
		t.Fatalf("large root IN rows=%d, want %d", got, len(ids))
	}
}

func existingBattleIDs(t *testing.T, db *orm.DB, limit int) []int64 {
	t.Helper()
	query := "SELECT seq FROM battle ORDER BY seq LIMIT ?"
	if db.Driver() == "postgres" {
		query = "SELECT seq FROM battle ORDER BY seq LIMIT $1"
	}
	rows, err := db.SQL.Query(query, limit)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	ids := make([]int64, 0, limit)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(ids) < limit {
		t.Fatalf("fixture has %d battle rows, want at least %d", len(ids), limit)
	}
	return ids
}
