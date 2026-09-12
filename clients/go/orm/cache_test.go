package orm

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestStatementCacheEvictsOldestAndCloseIsIdempotent(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db := &DB{SQL: sqlDB, cfg: Config{StatementCacheSize: 2}, stmts: map[string]*sql.Stmt{}}
	ctx := context.Background()
	for _, query := range []string{"SELECT 1", "SELECT 2", "SELECT 3"} {
		if _, err := db.stmt(ctx, query); err != nil {
			t.Fatalf("prepare %q: %v", query, err)
		}
	}
	if got := len(db.stmts); got != 2 {
		t.Fatalf("statement cache size=%d, want 2", got)
	}
	if _, ok := db.stmts["SELECT 1"]; ok {
		t.Fatal("oldest statement was not evicted")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db.planMu.RLock()
	if len(db.plans) != 0 || len(db.planOrder) != 0 {
		db.planMu.RUnlock()
		t.Fatal("plan cache was not cleared on close")
	}
	db.planMu.RUnlock()
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := db.stmt(ctx, "SELECT 4"); err == nil {
		t.Fatal("prepare after close succeeded")
	}
}
