package orm

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSchemaInstalledUsesSQLitePhysicalTable(t *testing.T) {
	db, err := sql.Open("sqlite", "file:orm-schema-installed?mode=memory&cache=shared")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE initialization (seq INTEGER PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	executor := &DB{SQL: db, driver: "sqlite", stmts: map[string]*sql.Stmt{}}
	tx, err := Begin(context.Background(), executor, TransactionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if exists, err := tx.SchemaInstalled(context.Background(), "core", "initialization"); err != nil || !exists {
		t.Fatalf("SQLite logical schema lookup = %v, %v; want true", exists, err)
	}
	if exists, err := tx.SchemaInstalled(context.Background(), "core", "missing"); err != nil || exists {
		t.Fatalf("SQLite missing table lookup = %v, %v; want false", exists, err)
	}
}
