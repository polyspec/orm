package orm

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestConnectionLeaseReportsAndReleasesORMPoolConnection(t *testing.T) {
	sqlDB, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	sqlDB.SetMaxOpenConns(1)
	db := &DB{SQL: sqlDB}

	lease, err := db.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	stats := db.Stats()
	if stats.OpenConnections != 1 || stats.InUse != 1 || stats.Idle != 0 {
		t.Fatalf("leased stats=%+v", stats)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	stats = db.Stats()
	if stats.OpenConnections != 1 || stats.InUse != 0 || stats.Idle != 1 {
		t.Fatalf("released stats=%+v", stats)
	}
}
