package orm

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSavepointRollsBackOnlyChangesAfterMarker(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	ex := &Tx{tx: tx}
	ctx := context.Background()
	if _, err = tx.Exec(`INSERT INTO probe VALUES (1, 'before')`); err != nil {
		t.Fatal(err)
	}
	if err = ex.Savepoint(ctx, "before_second"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(`INSERT INTO probe VALUES (2, 'after')`); err != nil {
		t.Fatal(err)
	}
	if err = ex.RollbackTo(ctx, "before_second"); err != nil {
		t.Fatal(err)
	}
	if err = ex.ReleaseSavepoint(ctx, "before_second"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM probe`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("savepoint rollback kept %d rows, want 1", count)
	}
}

func TestSavepointRejectsIdentifierInjection(t *testing.T) {
	if validSavepointName("safe_name_1") != true {
		t.Fatal("valid savepoint name rejected")
	}
	if validSavepointName("safe_name; DROP TABLE probe") {
		t.Fatal("savepoint injection accepted")
	}
}
