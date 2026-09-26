package main

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestSnapshotIncludesRowsAndSequenceState(t *testing.T) {
	db, err := sql.Open("sqlite", t.TempDir()+"/state.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	before, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO items (value) VALUES ('first')"); err != nil {
		t.Fatal(err)
	}
	withRow, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before == withRow {
		t.Fatal("inserted row did not change snapshot")
	}
	if _, err := db.Exec("DELETE FROM items"); err != nil {
		t.Fatal(err)
	}
	afterDelete, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before == afterDelete {
		t.Fatal("advanced sequence was hidden after row deletion")
	}
}

func TestRestoreDeclaredSequenceAfterWrite(t *testing.T) {
	db, err := sql.Open("sqlite", t.TempDir()+"/restore.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE battle (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)"); err != nil {
		t.Fatal(err)
	}
	before, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	counters, err := readCounters(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO battle (name) VALUES ('temp')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM battle"); err != nil {
		t.Fatal(err)
	}
	if err := restoreCounters(db, "sqlite", counters); err != nil {
		t.Fatal(err)
	}
	after, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("database state changed after declared sequence cleanup")
	}
}
