package orm_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"

	"github.com/polyspec/orm/packages/go/testcase"
)

type sqliteSequenceSnapshot struct {
	value   int64
	present bool
}

func readSQLiteSequence(ctx context.Context, db *sql.DB, table string) (sqliteSequenceSnapshot, error) {
	var snapshot sqliteSequenceSnapshot
	err := db.QueryRowContext(ctx, "SELECT seq FROM sqlite_sequence WHERE name = ?", table).Scan(&snapshot.value)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshot, nil
	}
	if err != nil {
		return sqliteSequenceSnapshot{}, err
	}
	snapshot.present = true
	return snapshot, nil
}

func restoreSQLiteSequence(ctx context.Context, db *sql.DB, table string, snapshot sqliteSequenceSnapshot) error {
	if !snapshot.present {
		_, err := db.ExecContext(ctx, "DELETE FROM sqlite_sequence WHERE name = ?", table)
		return err
	}
	result, err := db.ExecContext(ctx, "UPDATE sqlite_sequence SET seq = ? WHERE name = ?", snapshot.value, table)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 1 {
		return nil
	}
	if affected != 0 {
		return fmt.Errorf("restored %d sqlite_sequence rows for %s", affected, table)
	}
	_, err = db.ExecContext(ctx, "INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", table, snapshot.value)
	return err
}

func TestCatalogSQLiteSequenceRestoration(t *testing.T) {
	testcase.Start(t, testcase.Compute)
	ctx := context.Background()
	raw, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	raw.SetMaxOpenConns(1)
	defer testcase.Close(t, raw)
	if _, err := raw.ExecContext(ctx, "CREATE TABLE bind_cell (seq INTEGER PRIMARY KEY AUTOINCREMENT)"); err != nil {
		t.Fatal(err)
	}
	initial, err := readSQLiteSequence(ctx, raw, "bind_cell")
	if err != nil || initial.present {
		t.Fatalf("initial sequence = %+v, err %v; want absent", initial, err)
	}
	if _, err := raw.ExecContext(ctx, "INSERT INTO bind_cell (seq) VALUES (?)", -10); err != nil {
		t.Fatal(err)
	}
	created, err := readSQLiteSequence(ctx, raw, "bind_cell")
	if err != nil || !created.present || created.value != 0 {
		t.Fatalf("sequence after negative explicit key = %+v, err %v; want present zero", created, err)
	}
	if _, err := raw.ExecContext(ctx, "DELETE FROM bind_cell WHERE seq = ?", -10); err != nil {
		t.Fatal(err)
	}
	if err := restoreSQLiteSequence(ctx, raw, "bind_cell", initial); err != nil {
		t.Fatal(err)
	}
	final, err := readSQLiteSequence(ctx, raw, "bind_cell")
	if err != nil || final.present {
		t.Fatalf("sequence after restore = %+v, err %v; want absent", final, err)
	}
	if _, err := raw.ExecContext(ctx, "INSERT INTO bind_cell (seq) VALUES (?)", 7); err != nil {
		t.Fatal(err)
	}
	seeded, err := readSQLiteSequence(ctx, raw, "bind_cell")
	if err != nil || !seeded.present || seeded.value != 7 {
		t.Fatalf("seeded sequence = %+v, err %v; want 7", seeded, err)
	}
	if _, err := raw.ExecContext(ctx, "INSERT INTO bind_cell (seq) VALUES (?)", -11); err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ExecContext(ctx, "DELETE FROM bind_cell WHERE seq = ?", -11); err != nil {
		t.Fatal(err)
	}
	if err := restoreSQLiteSequence(ctx, raw, "bind_cell", seeded); err != nil {
		t.Fatal(err)
	}
	final, err = readSQLiteSequence(ctx, raw, "bind_cell")
	if err != nil || final != seeded {
		t.Fatalf("sequence after seeded restore = %+v, err %v; want %+v", final, err, seeded)
	}
}
