package main

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/polyspec/orm/internal/testcase"
)

func TestSnapshotIncludesRowsAndSequenceState(t *testing.T) {
	testcase.Start(t, testcase.Database)
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

func TestSQLiteStateWithoutAutoIncrement(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := sql.Open("sqlite", t.TempDir()+"/plain.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE state (value INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	var sequenceTables int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").Scan(&sequenceTables); err != nil {
		t.Fatal(err)
	}
	if sequenceTables != 0 {
		t.Fatal("fixture unexpectedly created sqlite_sequence")
	}
	counters, err := readCounters(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if len(counters) != 0 {
		t.Fatalf("ordinary SQLite table has counters: %v", counters)
	}
	before, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO state (value) VALUES (7)"); err != nil {
		t.Fatal(err)
	}
	after, err := snapshotDatabase(db, "sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("row change disappeared when sqlite_sequence was absent")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := readCounters(db, "sqlite"); err == nil {
		t.Fatal("an unrelated counter query error was accepted as an absent sequence")
	}
}

func TestRestoreDeclaredSequenceAfterWrite(t *testing.T) {
	testcase.Start(t, testcase.Database)
	db, err := sql.Open("sqlite", t.TempDir()+"/restore.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE author (seq INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)"); err != nil {
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
	if _, err := db.Exec("INSERT INTO author (name) VALUES ('temp')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM author"); err != nil {
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
